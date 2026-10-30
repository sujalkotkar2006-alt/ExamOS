"""Offline object counts only. Camera is opened only by an explicitly consented worker."""
import base64
import hashlib
import threading
import time
import uuid
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

import cv2
import numpy as np
from event_clip import encode_clip
from event_gate import EventGate

MODEL_HASH = 'c5c2d13e59ae883e6af3b45daea64af4833a4951c92d116ec270d9ddbe998063'




class Detector:
    def __init__(self):
        model = Path(__file__).parent / 'models' / 'yolox.onnx'
        if hashlib.sha256(model.read_bytes()).hexdigest() != MODEL_HASH:
            raise ValueError('Camera detection model missing or checksum mismatch')
        self.net = cv2.dnn.readNetFromONNX(str(model))
        grid, strides = [], []
        for stride in (8, 16, 32):
            y, x = np.meshgrid(np.arange(640 // stride), np.arange(640 // stride), indexing='ij')
            grid.append(np.stack((x, y), axis=-1).reshape(-1, 2))
            strides.append(np.full((x.size, 1), stride))
        self.grid = np.concatenate(grid)
        self.strides = np.concatenate(strides)

    def counts(self, frame):
        h, w = frame.shape[:2]
        ratio = min(640 / h, 640 / w)
        resized = cv2.resize(frame, (int(w * ratio), int(h * ratio)))
        canvas = np.full((640, 640, 3), 114, dtype=np.uint8)
        canvas[:resized.shape[0], :resized.shape[1]] = resized
        # OpenCV Zoo YOLOX uses raw BGR, CHW, no scaling/mean subtraction.
        blob = cv2.dnn.blobFromImage(canvas, 1.0, (640, 640), swapRB=False)
        self.net.setInput(blob)
        rows = self.net.forward().reshape(-1, 85).copy()
        rows[:, :2] = (rows[:, :2] + self.grid) * self.strides
        rows[:, 2:4] = np.exp(np.clip(rows[:, 2:4], -10, 10)) * self.strides
        counts = {}
        best = 0.0
        for category, name in ((0, 'personCount'), (67, 'phoneCount')):
            confidence = rows[:, 4] * rows[:, 5 + category]
            selected = rows[confidence >= 0.45]
            scores = confidence[confidence >= 0.45]
            boxes = np.concatenate((selected[:, :2] - selected[:, 2:4] / 2, selected[:, 2:4]), axis=1)
            indices = cv2.dnn.NMSBoxes(boxes.tolist(), scores.tolist(), .45, .45)
            counts[name] = len(indices)
            counts['phoneConfidence' if category == 67 else 'personConfidence'] = round(float(scores[np.array(indices).flatten()].min()),3) if len(indices) else None
            if len(indices):
                best = max(best, float(scores[np.array(indices).flatten()].max()))
        counts['confidence'] = round(best, 3)
        return counts


class CameraMonitor:
    def __init__(self, call, show, eligible):
        self.call, self.show, self.eligible = call, show, eligible
        self.stop_event = threading.Event()
        self.thread = None
        self.lock = threading.RLock()
        self.status = 'off'
        self.session_id = None
        self.lease_until = 0
        self.indicator_ready = threading.Event()
        self.check_requested = threading.Event()
        self.generation = 0
        self.upload_slots = threading.BoundedSemaphore(2)
        self.check_lock=threading.Lock()
        self.requested_check_id=None
        self.snapshots_enabled=False

    def running(self):
        return bool(self.thread and self.thread.is_alive())

    def stop(self):
        # Prevent all subsequent publication immediately; resource release is in finally.
        self.stop_event.set()
        self.status = 'stopping' if self.running() else 'off'

    def start(self, session_id, snapshots, device_index=0, clips=False, consent_policy=None):
        if self.running():
            return
        self.stop_event.clear()
        self.indicator_ready.clear()
        self.check_requested.clear()
        self.requested_check_id=None
        self.snapshots_enabled=bool(snapshots)
        self.session_id = session_id
        self.generation += 1
        self.status = 'starting'
        policy=dict(consent_policy or {'retentionDays':7,'clipSeconds':10,'cooldownSeconds':30})
        self.thread = threading.Thread(target=self._run, args=(session_id, snapshots, device_index, clips, self.generation,policy), daemon=True)
        self.thread.start()

    def permitted(self):
        return not self.stop_event.is_set() and time.monotonic() < self.lease_until and self.eligible(self.session_id)

    def request_check(self,request_id=None):
        if self.status!='active' or not self.permitted() or not self.snapshots_enabled:
            return False
        with self.check_lock:
            if self.check_requested.is_set():
                return False
            self.requested_check_id=request_id
            self.check_requested.set()
        self.show('evidence_progress','Camera check requested — capturing the next consented webcam frame')
        return True

    def _run(self, sid, snapshots, index, clips, generation,policy):
        capture = None
        granted = False
        status = 'off'
        try:
            granted = True  # Even a cancelled acknowledgement must clear a possibly accepted server grant.
            result = self.call('camera-consent', {'sessionId': sid, 'accept': True, 'snapshots': snapshots, 'clips': bool(clips and snapshots),**{k:policy.get(k,v) for k,v in [('retentionDays',7),('clipSeconds',10),('cooldownSeconds',30)]}})
            if not result.get('ok'):
                raise ValueError(result.get('error', 'Camera consent rejected'))
            granted = True
            grant = result.get('grantId')
            self.grant=grant
            self.grant_accepted_at=time.monotonic()
            self.clips_enabled=bool(clips and snapshots and grant)
            clip_seconds = max(4,min(20,int(result.get('clipSeconds',10))))
            cooldown = max(10,min(300,int(result.get('cooldownSeconds',30))))
            clock_offset = datetime.fromisoformat(result['serverNow'].replace('Z','+00:00')).timestamp()-time.time() if result.get('serverNow') else 0
            clip_enabled = bool(clips and snapshots and grant)
            ring, pending = deque(maxlen=81), []
            detector = Detector()
            if not self.permitted():
                return
            self.status = 'active'
            self.show('camera_state', 'CAMERA ACTIVE — opening consented device; no audio')
            if not self.indicator_ready.wait(2) or not self.permitted():
                return
            # This is the only camera-open call; after UI and server consent, with an active exam.
            capture = cv2.VideoCapture(index, cv2.CAP_DSHOW)
            capture.set(cv2.CAP_PROP_FRAME_WIDTH, 640)
            capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 480)
            if not capture.isOpened():
                status = 'unavailable'
                raise ValueError('Webcam unavailable. Check Windows camera privacy permission and other camera applications.')
            if not self.permitted():
                return
            result = self.call('camera-status', {'sessionId': sid, 'status': 'active'})
            if not result.get('ok'):
                raise ValueError(result.get('error', 'Camera permission ended'))
            self.status = 'active'
            self.show('camera_state', 'CAMERA ACTIVE — local preview; objective object counts only')
            if not self.indicator_ready.wait(2) or not self.permitted():
                return
            gate = EventGate()
            first_frame=True
            while self.permitted():
                ok, frame = capture.read()
                if not ok or frame is None or frame.size == 0 or frame.ndim != 3 or frame.shape[2] != 3:
                    status = 'disconnected'
                    raise ValueError('Webcam disconnected or capture failed. Camera stopped; this is not a misconduct finding.')
                if not self.permitted():
                    break
                if first_frame:
                    self.show('frame_captured','valid real webcam frame')
                    first_frame=False
                stamp = time.monotonic()
                wall = time.time()+clock_offset
                jpeg_bytes = None
                if snapshots:
                    encoded, jpg = cv2.imencode('.jpg', cv2.resize(frame,(320,240)),[cv2.IMWRITE_JPEG_QUALITY,55])
                    if not encoded:
                        raise ValueError('Snapshot encoding failed; evidence capture stopped')
                    jpeg_bytes = jpg.tobytes()
                    if cv2.imdecode(np.frombuffer(jpeg_bytes,dtype=np.uint8),cv2.IMREAD_COLOR) is None:
                        raise ValueError('Corrupted snapshot; not uploaded')
                if clip_enabled:
                    item=(stamp,wall,jpeg_bytes)
                    ring.append(item)
                    while ring and stamp-ring[0][0]>clip_seconds/2:
                        ring.popleft()
                    for job in list(pending):
                        if stamp<=job['until']:
                            job['frames'].append(item)
                        if stamp>=job['until']:
                            pending.remove(job)
                            self._queue_clip(sid,job,grant,generation)
                counts = detector.counts(frame)
                gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
                facts = {'phone_detected': (counts['phoneCount'] > 0, 2),
                         'no_person_detected': (counts['personCount'] == 0, 5),
                         'multiple_people': (counts['personCount'] > 1, 3),
                         'camera_obstructed': (float(gray.mean()) < 12 and float(gray.std()) < 10, 3)}
                request_id=None
                if self.check_requested.is_set():
                    with self.check_lock:
                        request_id=self.requested_check_id
                        self.requested_check_id=None
                        self.check_requested.clear()
                    facts['camera_check'] = (True, 0)
                preview = cv2.cvtColor(cv2.resize(frame, (240, 135)), cv2.COLOR_BGR2RGB)
                with self.lock:
                    if not self.permitted():
                        break
                    self.show('camera_frame', preview)
                now = time.monotonic()
                for category, (present, threshold) in facts.items():
                    if category!='camera_check' and not gate.eligible(category,present,now,threshold,cooldown):
                        continue
                    if category=='camera_check':gate.since[category]=now
                    confidence = counts.get('phoneConfidence') if category=='phone_detected' else counts.get('personConfidence') if category=='multiple_people' else None
                    detail = {k:v for k,v in counts.items() if k in ('personCount','phoneCount')}
                    detail['seconds']=round(now-gate.since[category],1)
                    if confidence is not None:
                        detail['confidence']=confidence
                    detected_wall=time.time()+clock_offset
                    payload = {'sessionId': sid, 'category': category, 'clientEventId':str(uuid.uuid4()),
                               'detail': detail,'grantId':grant,
                               'observedAt':datetime.fromtimestamp(detected_wall,timezone.utc).isoformat(timespec='milliseconds'),
                               'capturedAt':datetime.fromtimestamp(wall,timezone.utc).isoformat(timespec='milliseconds'),
                               'clipExpected':clip_enabled and len(pending)<2}
                    if category=='camera_check' and request_id:payload['requestId']=request_id
                    if snapshots:
                        payload['jpeg'] = base64.b64encode(jpeg_bytes).decode('ascii')
                    # The same lock synchronizes stop with event publication.
                    with self.lock:
                        if not self.permitted():
                            break
                        response = self.call('proctor-event', payload)
                    if not response.get('ok'):
                        raise ValueError(response.get('error', 'Observation rejected'))
                    if response.get('throttled'):
                        self.show('evidence_error','Camera check/event was rate limited; wait a few seconds before requesting another. No new snapshot was stored.')
                        continue
                    if response.get('hasEvidence'):
                        self.show('snapshot_saved',response.get('evidenceId') or response['id'])
                    gate.commit(category,now)
                    if response.get('id') and response.get('clipExpected') and clip_enabled:
                        pending.append({'id':response['id'],'frames':list(ring),'until':now+clip_seconds/2})
                self.stop_event.wait(.25)
        except Exception as exc:
            if not self.stop_event.is_set():
                self.show('camera_state', 'CAMERA STOPPED: ' + str(exc))
                if status == 'off':
                    status = 'unavailable'
        finally:
            if 'ring' in locals():
                ring.clear()
                if pending:
                    self.show('evidence_error','Camera stopped: incomplete clips unavailable. Queued snapshots remain encrypted for retry with fresh consent.')
                pending.clear()
            if capture is not None:
                capture.release()
            self.status = 'off'
            self.show('camera_frame', None)
            if granted:
                try:
                    self.call('camera-status', {'sessionId': sid, 'status': status})
                except Exception:
                    pass  # Server heartbeat lease also revokes consent on network failure.
            self.show('camera_released', status)

    def _queue_clip(self, sid, job, grant, generation):
        if not self.upload_slots.acquire(blocking=False):
            self.show('evidence_error','Clip queue full; snapshot is retained, clip unavailable')
            return
        def work():
            allowed=lambda:self.permitted() and generation==self.generation and sid==self.session_id
            try:
                data=encode_clip(job['frames'],allowed)
                if not allowed():
                    return
                result=self.call('incident-clip',{'sessionId':sid,'id':job['id'],'dependency':job['id'],'grantId':grant,'bytes':data,
                    'startedAt':datetime.fromtimestamp(job['frames'][0][1],timezone.utc).isoformat(timespec='milliseconds'),
                    'endedAt':datetime.fromtimestamp(job['frames'][-1][1],timezone.utc).isoformat(timespec='milliseconds')})
                if not result.get('ok'):
                    raise ValueError(result.get('error','Clip storage failed'))
                if not result.get('queued'):
                    self.show('evidence_saved',job['id'])
            except Exception as exc:
                if allowed():
                    self.show('evidence_error','Clip not saved: '+str(exc)+'. The original incident and snapshot remain available.')
            finally:
                job['frames'].clear()
                self.upload_slots.release()
        threading.Thread(target=work,daemon=True).start()
