"""Visible, consent-based Windows exam agent. No input hooks or background service."""
import base64
import io
import json
import os
import queue
import threading
import time
import webbrowser
import hashlib
import re
import tempfile
from datetime import datetime
import tkinter as tk
from tkinter import messagebox
from pathlib import Path
from urllib.parse import urlparse
import requests
import socketio
import psutil
from PIL import Image, ImageTk
from monitoring_lifecycle import ConsentGate, may_renew_lease
from camera_monitor import CameraMonitor
from evidence_uploads import EvidenceUploads
from exam_environment import ExamEnvironment
from mss import MSS
import win32gui
import win32process
import win32crypt

CONFIG = Path(os.environ.get('EXAMOS_CONFIG_PATH', str(Path(os.environ.get('LOCALAPPDATA', '.')) / 'ExamOS' / 'device.dat')))


def server_origin(value):
    parsed = urlparse(value.strip())
    try:
        parsed.port
    except ValueError:
        raise ValueError('The server URL has an invalid port.') from None
    if not parsed.hostname or parsed.scheme not in ('http', 'https') or parsed.username or parsed.password:
        raise ValueError('Enter the complete ExamOS server URL, for example http://127.0.0.1:3000 for this computer.')
    if parsed.path.rstrip('/') or parsed.query or parsed.fragment:
        raise ValueError('Use the server origin only, without /api, /student, or another page path.')
    if parsed.scheme != 'https' and parsed.hostname not in ('localhost', '127.0.0.1', '::1'):
        raise ValueError('HTTPS with a trusted certificate is required for LAN connections.')
    return parsed.scheme + '://' + parsed.netloc.lower()




class Agent:
    def __init__(self, root):
        self.root = root
        self.root.title('ExamOS — Student consent')
        self.root.geometry('760x680')
        self.root.minsize(720, 640)
        self.root.protocol('WM_DELETE_WINDOW', self.close)
        self.root.bind('<Unmap>', lambda event: self.withdraw('minimized') if event.widget == self.root and not self.closing else None)
        self.root.bind('<Escape>', lambda event: self.withdraw('keyboard_stop'))
        self.gate = ConsentGate()
        self.ui = queue.Queue()
        self.quit = threading.Event()
        self.network_lock = threading.RLock()
        self.consent_generation = 0
        self.screen_granted_at = 0
        self.consent_pending = False
        self.stopping = False
        self.closing = False
        self.consent_jobs = queue.Queue()
        threading.Thread(target=self.consent_worker, daemon=True).start()
        self.indicator_ready = False
        self.client = None
        self.config = None
        self.last_error = None
        self.exam_state = None
        self.attempt_until = None
        self.camera_lease = 0
        self.camera_policy={'retentionDays':7,'clipSeconds':10,'cooldownSeconds':30}
        self.camera_frame = None
        self.camera_frame_pending = False
        self.camera_frame_lock = threading.Lock()
        self.environment = ExamEnvironment()
        self.last_switch = 0
        self.camera = CameraMonitor(self.camera_call, self.camera_show, self.camera_eligible)
        self.uploads = EvidenceUploads(CONFIG.parent / (CONFIG.stem+'-evidence'), self.transmit_evidence, self.upload_eligible, lambda: getattr(self.camera,'grant',None), self.camera_show)
        tk.Label(root, text='◉ ExamOS', font=('Segoe UI', 15, 'bold')).pack(pady=(4, 1))
        self.status = tk.Label(root, text='NOT MONITORING', bg='#e7eee9', fg='#244333', font=('Segoe UI', 12, 'bold'), pady=3)
        self.status.pack(fill='x', padx=15)
        self.compact_ui = False
        self.camera_indicator = tk.Label(root, text='CAMERA OFF', font=('Segoe UI', 8, 'bold'))
        self.camera_indicator.pack(pady=1)
        self.compact_button = tk.Button(root, text='Compact monitoring panel', command=self.toggle_compact, font=('Segoe UI', 8))
        self.compact_button.pack(pady=1)
        self.connection_status = tk.Label(root, text='Disconnected — enroll a device or reconnect its saved enrollment', wraplength=680, font=('Segoe UI', 8), fg='#506b5a')
        self.connection_status.pack(fill='x', padx=15, pady=1)
        self.upload_diagnostic=tk.Label(root,text='Evidence uploads: idle',wraplength=680, font=('Segoe UI', 8))
        self.upload_diagnostic.pack(pady=1)
        tk.Button(root,text='Retry pending uploads',command=self.uploads.retry, font=('Segoe UI', 8)).pack(pady=1)
        tk.Label(root, text='Screen consent shares primary display every 2 seconds and active app name. Camera requires separate consent.\nNo audio, keystrokes, passwords, or clipboard collected. Close private screen content before accepting. Stop with Escape.', justify='left', font=('Segoe UI', 8)).pack(pady=1)
        frame = tk.Frame(root)
        frame.pack(fill='x', padx=15, pady=1)
        self.url = self.entry(frame, 'Server URL (HTTPS on LAN)', 'http://127.0.0.1:3000')
        self.name = self.entry(frame, 'Device / student label', '')
        self.code = self.entry(frame, 'One-use enrollment code', '')
        self.connect_button = tk.Button(frame, text='Enroll / Connect', command=self.connect, font=('Segoe UI', 8, 'bold'))
        self.connect_button.pack(pady=1)
        self.session_label = tk.Label(root, text='No examination session', wraplength=600, font=('Segoe UI', 8))
        self.session_label.pack(pady=1)
        buttons = tk.Frame(root)
        self.monitoring_buttons = buttons
        buttons.pack(pady=1)
        self.accept_button = tk.Button(buttons, text='I consent — start sharing', command=self.toggle_monitoring, state='disabled', takefocus=True, font=('Segoe UI', 9, 'bold'))
        self.accept_button.pack(side='left', padx=6)
        self.exam_button = tk.Button(root, text='Open examination page', command=self.open_examination, state='disabled', font=('Segoe UI', 8))
        self.exam_button.pack(pady=1)
        self.dedicated = tk.BooleanVar(value=True)
        tk.Checkbutton(root, text='Dedicated Edge examination window (limited lockdown — does not block app switching)', variable=self.dedicated, font=('Segoe UI', 8)).pack(pady=1)
        camera_box = tk.LabelFrame(root, text='Optional camera — no identity, gaze, attention, or movement judgments', font=('Segoe UI', 8, 'bold'))
        camera_box.pack(fill='x', padx=15, pady=2)
        self.camera_consent = tk.BooleanVar(value=False)
        self.snapshot_consent = tk.BooleanVar(value=False)
        self.clip_consent = tk.BooleanVar(value=False)
        tk.Checkbutton(camera_box, text='I consent to local camera analysis of person / phone presence.', variable=self.camera_consent, command=self.camera_option_changed, font=('Segoe UI', 8)).pack(anchor='w', pady=1)
        cam_subchecks = tk.Frame(camera_box)
        cam_subchecks.pack(fill='x', pady=1)
        self.snapshot_check = tk.Checkbutton(cam_subchecks, text='Allow event / teacher-check snapshots (teacher only; up to 7 days).', variable=self.snapshot_consent, command=self.camera_option_changed, font=('Segoe UI', 8))
        self.snapshot_check.pack(side='left', padx=2)
        self.clip_check = tk.Checkbutton(cam_subchecks, text='Allow silent event / check clips: 10s (5s before / after).', variable=self.clip_consent, command=self.camera_option_changed, font=('Segoe UI', 8))
        self.clip_check.pack(side='left', padx=2)
        self.evidence_status = tk.Label(camera_box, text='Evidence requires separate opt-in. Failed uploads encrypted locally up to 15m; reconnect and retry. Observations for review, not proof.', wraplength=700, font=('Segoe UI', 8))
        self.evidence_status.pack(pady=1)
        cam_action_buttons = tk.Frame(camera_box)
        cam_action_buttons.pack(pady=1)
        self.camera_button = tk.Button(cam_action_buttons, text='Start camera after starting exam', state='disabled', command=self.toggle_camera, font=('Segoe UI', 8))
        self.camera_button.pack(side='left', padx=4)
        tk.Button(cam_action_buttons, text='Send camera check (consented snapshot only)', command=self.send_camera_check, font=('Segoe UI', 8)).pack(side='left', padx=4)
        self.camera_status = tk.Label(camera_box, text='CAMERA OFF — not accessed', fg='#244333', font=('Segoe UI', 8, 'bold'), wraplength=650)
        self.camera_status.pack(pady=1)
        self.camera_preview = tk.Label(camera_box)
        self.camera_preview.image = None
        self.camera_preview.pack(pady=1)
        if CONFIG.exists():
            try:
                self.config = json.loads(win32crypt.CryptUnprotectData(CONFIG.read_bytes(), None, None, None, 0)[1])
                self.url.delete(0, 'end')
                self.url.insert(0, self.config['url'])
                self.name.insert(0, self.config['name'])
                self.connection_status.config(text='Saved enrollment available — leave the code blank to reconnect')
            except Exception:
                self.ui.put(('error', 'Stored credentials could not be opened. Re-enroll this device.'))
        self.root.after(100, self.poll)

    def entry(self, parent, label, default):
        row = tk.Frame(parent)
        row.pack(fill='x', pady=1)
        tk.Label(row, text=label, width=25, anchor='w', font=('Segoe UI', 8)).pack(side='left')
        field = tk.Entry(row, font=('Segoe UI', 8))
        field.pack(side='left', fill='x', expand=True)
        field.insert(0, default)
        return field

    def connect(self):
        if self.client and self.client.connected:
            return
        name = self.name.get().strip()
        code = re.sub(r'\s+', '', self.code.get()).lower()
        try:
            url = server_origin(self.url.get())
            if code and not re.fullmatch('[0-9a-f]{24}', code):
                raise ValueError('Copy the complete 24-character enrollment code from the teacher dashboard.')
            if code and (not name or len(name) > 80):
                raise ValueError('Enter a device/student name of 1–80 characters before enrolling.')
            if not code and (not self.config or server_origin(self.config['url']) != url):
                raise ValueError('Enter a fresh enrollment code for this server. A saved enrollment can only reconnect to its original server URL.')
        except ValueError as exc:
            messagebox.showerror('Enrollment details', str(exc))
            return
        self.connect_button.config(state='disabled')
        self.last_error = None
        self.connection_status.config(text='Connecting to ' + url + '…')
        def work():
            stage = 'enrollment'
            try:
                fingerprint = hashlib.sha256(code.encode()).hexdigest() if code else None
                already_enrolled = bool(self.config and server_origin(self.config['url']) == url and (not code or self.config.get('enrollment_code_hash') == fingerprint))
                if code and not already_enrolled:
                    response = requests.post(url + '/api/enroll', json={'code': code, 'name': name}, timeout=8)
                    try:
                        payload = response.json()
                    except requests.exceptions.JSONDecodeError:
                        raise ValueError('This server did not return an ExamOS enrollment response. Check the server URL.') from None
                    if not response.ok:
                        raise ValueError(payload.get('error', 'Enrollment request was rejected.'))
                    if not payload.get('id') or not isinstance(payload.get('token'), str):
                        raise ValueError('The server did not return a valid device credential.')
                    self.config = dict(payload, url=url, name=name, enrollment_code_hash=fingerprint)
                    # The code is already consumed by HTTP enrollment, independently of the socket connection.
                    self.ui.put(('enrolled', 'Enrollment accepted — connecting with the saved device credential…'))
                    try:
                        CONFIG.parent.mkdir(parents=True, exist_ok=True)
                        encrypted = win32crypt.CryptProtectData(json.dumps(self.config).encode(), 'ExamOS device', None, None, None, 0)
                        with tempfile.NamedTemporaryFile(dir=CONFIG.parent, prefix='device-', suffix='.tmp', delete=False) as output:
                            output.write(encrypted)
                            temporary = output.name
                        os.replace(temporary, CONFIG)
                    except Exception:
                        self.ui.put(('warning', 'Enrollment succeeded, but the credential could not be saved to disk. This window can reconnect without a new code; keep it open and check the credential folder permissions.'))
                elif code:
                    self.ui.put(('enrolled', 'This agent already accepted that code — reconnecting its existing device…'))
                stage = 'connection'
                http_session = requests.Session()
                http_session.verify = os.environ.get('REQUESTS_CA_BUNDLE') or True
                client = socketio.Client(reconnection=False, request_timeout=4, http_session=http_session)
                self.client = client
                @client.on('session')
                def session(data):
                    if self.client is client and client.connected:
                        self.update_session(data)
                @client.on('exam-finished')
                def exam_finished(data):
                    if self.client is not client: return
                    self.exam_state = {'status': 'submitted'}
                    self.gate.stop()
                    self.camera.stop()
                    self.environment.close()
                    self.ui.put(('stop_monitoring', 'exam_finished'))
                @client.on('stop-monitoring')
                def monitoring_stopped(data):
                    if self.client is not client: return
                    self.gate.stop()
                    self.camera.stop()
                    self.environment.close()
                    self.ui.put(('stop_monitoring', 'student_stop'))
                @client.on('camera-check-request')
                def camera_check_requested(data):
                    if self.client is not client: return {'ok':False,'error':'Replaced connection'}
                    if data.get('sessionId')!=self.camera.session_id or not self.camera.request_check(data.get('requestId')):
                        return {'ok':False,'error':'Camera or snapshot consent is not active, or another check is pending'}
                    return {'ok':True,'requestId':data.get('requestId')}
                @client.event
                def disconnect(*args):
                    if self.client is client:
                        self.gate.stop()
                        self.camera.stop()
                        self.environment.close()
                        self.ui.put(('disconnected', None))
                # Start with HTTP polling; upgrade to WebSocket when available, but do not require it.
                client.connect(url, auth={'token': self.config['token']}, transports=['polling', 'websocket'], wait_timeout=8)
                self.ui.put(('connected', None))
                threading.Thread(target=self.monitor, args=(client,), daemon=True).start()
            except Exception as exc:
                self.gate.stop()
                message = str(exc)
                if stage == 'connection':
                    message = 'Device enrollment is saved, but the connection to ' + url + ' failed: ' + message + '. Click Reconnect with the code field blank. If the device was revoked, use a newly generated code.'
                elif isinstance(exc, requests.exceptions.RequestException):
                    message = 'Cannot complete enrollment at ' + url + ': ' + message + '. Check that this is the same server shown in the teacher dashboard.'
                self.ui.put(('connection_error', message))
        threading.Thread(target=work, daemon=True).start()

    def update_session(self, data):
        with self.gate.lock:
            old = self.gate.session
            if not data or not old or old['id'] != data['id']:
                self.gate.stop()
                self.camera.stop()
                self.environment.close()
                self.exam_state = None
                self.ui.put(('environment_close', None))
            self.gate.session = data
        self.ui.put(('session', data))

    def accept(self):
        session = self.gate.session
        if self.exam_state and self.exam_state.get('status') in ('submitted', 'cancelled'):
            return
        if not session or not self.client or not self.client.connected or self.consent_pending or self.gate.allowed():
            return
        self.consent_pending = True
        self.consent_generation += 1
        self.accept_button.config(state='disabled')
        client = self.client
        generation = self.consent_generation
        def work():
            try:
                requested_at=time.monotonic()
                result = self.server_call(client, 'consent', {'sessionId': session['id'], 'accept': True}, timeout=4)
                with self.gate.lock:
                    if self.client is client and time.monotonic()<requested_at+6 and generation == self.consent_generation and result.get('ok') and self.gate.session and self.gate.session['id'] == session['id'] and client.connected:
                        self.screen_granted_at=time.monotonic()
                        self.gate.accepted = session['id']
                        self.gate.lease_until = min(requested_at + 6, self.attempt_until or float('inf'))
                        self.gate.stop_requested.clear()
            except Exception as exc:
                if generation == self.consent_generation:
                    self.gate.stop()
                self.ui.put(('error', str(exc)))
            finally:
                if generation == self.consent_generation:
                    self.consent_pending = False
        self.consent_jobs.put(work)

    def consent_worker(self):
        # Keep accept/stop requests ordered, without blocking the Tk UI.
        while True:
            job = self.consent_jobs.get()
            if job is None:
                return
            try:
                job()
            except Exception as exc:
                if not self.closing:
                    self.ui.put(('error', str(exc)))

    def server_call(self, client, name, payload, timeout, cancel=None):
        completed = threading.Event()
        result = []
        def acknowledge(response):
            result.append(response)
            completed.set()
        with self.network_lock:
            client.emit(name, payload, callback=acknowledge)
        deadline = time.monotonic() + timeout
        while not completed.wait(.05):
            if cancel and cancel.is_set():
                raise InterruptedError('Camera consent withdrawn')
            if time.monotonic() >= deadline:
                raise TimeoutError('Server did not acknowledge ' + name)
        return result[0]

    def toggle_monitoring(self):
        # A displayed Stop action must never become a fresh consent grant when a lease expires.
        if self.accept_button.cget('text') == 'Stop monitoring (Esc)' or self.gate.allowed() or self.consent_pending:
            self.withdraw()
        else:
            self.accept()

    def withdraw(self, reason='student_stop'):
        if self.stopping:
            return
        was_requested = self.gate.accepted is not None or self.camera.running() or self.consent_pending or self.accept_button.cget('text') == 'Stop monitoring (Esc)'
        self.gate.stop()
        self.camera.stop()
        self.camera_status.config(text='CAMERA STOPPING — releasing device' if self.camera.running() else 'CAMERA OFF — not accessed', fg='#244333')
        self.camera_consent.set(False)
        self.snapshot_consent.set(False)
        self.clip_consent.set(False)
        self.environment.close()
        self.consent_generation += 1
        generation = self.consent_generation
        self.gate.stop()  # Local capture stops before the network request.
        self.indicator_ready = False
        self.consent_pending = False
        last,pending=self.uploads.status()
        self.upload_diagnostic.config(text='Camera: '+self.camera.status+' | Snapshots: '+('allowed' if self.snapshot_consent.get() else 'off')+' | Backend: '+('connected' if self.client and self.client.connected else 'disconnected')+'\n'+last+' | Pending: '+str(pending))
        self.render_monitoring_controls()
        session = self.gate.session
        if was_requested and session and self.client and self.client.connected:
            client = self.client
            self.consent_pending = True
            self.stopping = True
            def notify():
                try:
                    self.server_call(client, 'consent', {'sessionId': session['id'], 'accept': False, 'reason': reason}, timeout=4)
                except Exception:
                    # Local capture is already stopped. Disconnect also invalidates server consent.
                    client.disconnect()
                    self.ui.put(('disconnected', None))
                finally:
                    if generation == self.consent_generation:
                        self.consent_pending = False
                    self.stopping = False
            self.consent_jobs.put(notify)

    def create_examination_link(self):
        if not self.config or not self.client or not self.client.connected:
            raise ValueError('Connect the enrolled device first.')
        response = requests.post(self.config['url'] + '/api/student/launch', headers={'Authorization': 'Bearer ' + self.config['token']}, json={}, timeout=8)
        if not response.ok:
            try:
                raise ValueError(response.json().get('error', 'Examination unavailable'))
            except requests.exceptions.JSONDecodeError:
                response.raise_for_status()
        return self.config['url'] + '/student#launch=' + response.json()['code']

    def open_examination(self):
        dedicated = self.dedicated.get()
        generation = self.consent_generation
        session_id = self.gate.session['id'] if self.gate.session else None
        def work():
            try:
                link = self.create_examination_link()
                if generation != self.consent_generation or not self.gate.session or self.gate.session['id'] != session_id:
                    return
                use_kiosk = dedicated and not (self.exam_state and self.exam_state.get('status') in ('submitted', 'cancelled'))
                if use_kiosk:
                    with self.environment.lock:
                        if generation != self.consent_generation or not self.gate.session or self.gate.session['id'] != session_id or (self.exam_state and self.exam_state.get('status') in ('submitted','cancelled')):
                            return
                        self.environment.open(link)
                else:
                    webbrowser.open(link)
                if self.gate.session:
                    self.server_call(self.client, 'exam-environment', {'sessionId': self.gate.session['id'], 'mode': 'limited_edge' if use_kiosk else 'browser_only'}, timeout=4)
            except Exception as exc:
                self.ui.put(('error', str(exc)))
        threading.Thread(target=work, daemon=True).start()

    def monitor(self, client):
        try:
            with MSS() as capture:
                while self.client is client and client.connected and not self.quit.is_set():
                    try:
                        requested_at=time.monotonic()
                        reply = self.server_call(client, 'heartbeat', {}, timeout=3)
                        if self.client is not client or not client.connected:
                            break
                        self.update_session(reply.get('session'))
                        self.exam_state = reply.get('exam')
                        self.attempt_until = None
                        if self.exam_state and self.exam_state.get('status') == 'started' and self.exam_state.get('deadline_at') and reply.get('serverNow'):
                            seconds = (datetime.fromisoformat(self.exam_state['deadline_at'].replace('Z','+00:00')) - datetime.fromisoformat(reply['serverNow'].replace('Z','+00:00'))).total_seconds()
                            self.attempt_until = requested_at + max(0, seconds)
                        if self.camera.running() and not may_renew_lease(self.camera.lease_until,requested_at,getattr(self.camera,'grant_accepted_at',0),reply.get('cameraConsented') if self.camera.status=='active' else None,received_at=time.monotonic()):
                            self.camera.stop()
                        else:
                            self.camera.lease_until = requested_at + 6
                        if self.gate.accepted and not may_renew_lease(self.gate.lease_until,requested_at,self.screen_granted_at,reply.get('screenConsented'),received_at=time.monotonic()):
                            self.gate.stop()
                            self.ui.put(('stop_monitoring','lease_expired'))
                        self.ui.put(('camera_policy', reply.get('proctoring', {})))
                        if self.exam_state and self.exam_state.get('status') in ('submitted', 'cancelled'):
                            self.gate.stop()
                            self.camera.stop()
                            self.ui.put(('environment_close', None))
                        with self.gate.lock:
                            # A lease expiry requires fresh consent; never silently resume.
                            if self.gate.accepted and time.monotonic() >= self.gate.lease_until:
                                self.ui.put(('stop_monitoring', 'lease_expired'))
                                self.gate.stop()
                            elif self.gate.accepted:
                                self.gate.lease_until = min(requested_at + 6, self.attempt_until or float('inf'))
                        if self.gate.allowed() and self.indicator_ready:
                            with self.gate.lock:
                                if not self.gate.allowed():
                                    continue
                                generation = self.consent_generation
                                session_id = self.gate.session['id']
                                try:
                                    _, pid = win32process.GetWindowThreadProcessId(win32gui.GetForegroundWindow())
                                    executable = psutil.Process(pid).name()
                                except (psutil.NoSuchProcess, psutil.AccessDenied):
                                    executable = '[unavailable]'
                                if self.environment.process and self.exam_state and self.exam_state.get('status') == 'started' and pid != os.getpid() and not self.environment.owns(pid) and time.monotonic() - self.last_switch > 30:
                                    self.last_switch = time.monotonic()
                                    with self.network_lock:
                                        client.emit('proctor-event', {'sessionId': session_id, 'category': 'application_switch', 'detail': {'mode': 'limited_edge'}})
                                shot = capture.grab(capture.monitors[1])
                            if not self.gate.allowed():
                                continue
                            # Never hold the consent gate while waiting on network I/O.
                            if self.gate.allowed():
                                image = Image.frombytes('RGB', shot.size, shot.rgb)
                                image.thumbnail((960, 540))
                                buffer = io.BytesIO()
                                image.save(buffer, format='JPEG', quality=45)
                                if buffer.tell() > 110000:
                                    image.thumbnail((640, 360))
                                    buffer = io.BytesIO()
                                    image.save(buffer, format='JPEG', quality=35)
                                if self.gate.allowed():
                                    with self.network_lock:
                                        with self.gate.lock:
                                            if self.gate.allowed() and generation == self.consent_generation:
                                                client.emit('sample', {'sessionId': session_id, 'app': executable, 'jpeg': base64.b64encode(buffer.getvalue()).decode('ascii')})
                    except (psutil.NoSuchProcess, psutil.AccessDenied):
                        pass
                    except Exception as exc:
                        if self.client is not client: break
                        self.gate.stop()
                        self.camera.stop()
                        self.ui.put(('monitoring_error', 'Sharing stopped: ' + str(exc)))
                        capture.close()  # Release native screen handles before a slow transport shutdown.
                        client.disconnect()
                        break
                    self.quit.wait(2)
        except Exception as exc:
            if self.client is not client: return
            self.gate.stop()
            self.ui.put(('monitoring_error', 'Capture unavailable: ' + str(exc)))
            client.disconnect()

    def poll(self):
        try:
            while True:
                kind, data = self.ui.get_nowait()
                if kind == 'error':
                    self.last_error = data
                    self.render_monitoring_controls()
                    messagebox.showerror('ExamOS', data)
                    self.connect_button.config(state='normal')
                elif kind=='monitoring_error':
                    self.last_error=data
                    self.connection_status.config(text=data+' — reconnect and consent again',fg='#a92e27')
                    self.connect_button.config(state='normal',text='Reconnect')
                    self.render_monitoring_controls()
                elif kind == 'disconnected':
                    self.environment.close()
                    self.connect_button.config(state='normal', text='Reconnect' if self.config else 'Enroll / Connect')
                    self.connection_status.config(text='Disconnected — saved enrollment retained; click Reconnect' if self.config else 'Disconnected — enter an enrollment code')
                    self.session_label.config(text='Disconnected — sharing stopped. Reconnect and consent again.')
                elif kind == 'connected':
                    self.code.delete(0, 'end')
                    self.connection_status.config(text='Connected — ' + self.config['name'] + ' · ' + self.config['url'] + ' · ' + self.client.transport())
                    self.connect_button.config(state='disabled', text='Connected')
                elif kind == 'enrolled':
                    self.code.delete(0, 'end')
                    self.connection_status.config(text=data)
                elif kind == 'warning':
                    messagebox.showwarning('Enrollment saved in this window', data)
                elif kind == 'connection_error':
                    self.last_error = data
                    self.connection_status.config(text='Not connected — saved enrollment available' if self.config else 'Enrollment not accepted — check the details below')
                    self.connect_button.config(state='normal', text='Reconnect' if self.config else 'Enroll / Connect')
                    messagebox.showerror('ExamOS enrollment / connection', data)
                elif kind == 'session':
                    self.session_label.config(text=('Examination: ' + data['name'] + '\nAllowed: ' + (', '.join(data['allowed_apps']) or 'No application restrictions')) if data else 'No active examination — sharing stopped')
                elif kind == 'closed':
                    self.root.destroy()
                    return
                elif kind == 'stop_monitoring':
                    self.withdraw(data)
                elif kind == 'environment_close':
                    self.environment.close()
                elif kind == 'camera_policy':
                    self.camera_policy=data
                    days=data.get('retentionDays',7)
                    seconds=data.get('clipSeconds',10)
                    self.snapshot_check.config(text=f'Allow event / teacher-check snapshots (teacher only; up to {days} days).')
                    self.clip_check.config(text=f'Allow silent event / check clips: up to {seconds}s ({seconds/2:g}s before / after); {days} days retention.')
                elif kind == 'camera_state':
                    self.camera_status.config(text=data, fg='#a92e27')
                    self.root.update_idletasks()
                    self.camera.indicator_ready.set()
                elif kind == 'camera_released':
                    self.camera_consent.set(False)
                    self.snapshot_consent.set(False)
                    self.clip_consent.set(False)
                    if data == 'off':
                        self.camera_status.config(text='CAMERA OFF — released', fg='#244333')
                elif kind == 'camera_frame':
                    with self.camera_frame_lock:
                        data = self.camera_frame
                        self.camera_frame = None
                        self.camera_frame_pending = False
                    if data is None or not self.camera.permitted():
                        self.camera_preview.config(image='')
                        self.camera_preview.image = None
                    else:
                        photo = ImageTk.PhotoImage(Image.fromarray(data))
                        self.camera_preview.config(image=photo)
                        self.camera_preview.image = photo
                elif kind == 'evidence_error':
                    self.evidence_status.config(text=data,fg='#a92e27')
                elif kind == 'evidence_saved':
                    self.evidence_status.config(text='Silent event clip saved for incident '+data,fg='#244333')
                elif kind=='snapshot_saved':
                    self.evidence_status.config(text='Snapshot uploaded and stored. Evidence ID: '+data,fg='#244333')
                elif kind=='evidence_progress':
                    self.evidence_status.config(text=data,fg='#244333')
        except queue.Empty:
            pass
        if self.gate.accepted and time.monotonic() >= self.gate.lease_until:
            self.withdraw('lease_expired')
        if self.camera.running() and not self.camera.permitted():
            self.camera.stop()
        camera_running = self.camera.running()
        self.camera_button.config(text='Stop camera' if camera_running else 'Start camera after starting exam', state='normal' if camera_running or self.camera_eligible(self.gate.session['id'] if self.gate.session else None) else 'disabled')
        last,pending=self.uploads.status()
        self.upload_diagnostic.config(text='Camera: '+self.camera.status+' | Snapshots: '+('allowed' if self.snapshot_consent.get() else 'off')+' | Backend: '+('connected' if self.client and self.client.connected else 'disconnected')+'\n'+last+' | Pending: '+str(pending))
        self.render_monitoring_controls()
        self.exam_button.config(state='normal' if self.gate.session and self.client and self.client.connected else 'disabled')
        self.root.after(100, self.poll)

    def render_monitoring_controls(self):
        sharing = self.gate.allowed()
        active = sharing or (self.camera.status == 'active' and self.camera.permitted())
        finished = self.exam_state and self.exam_state.get('status') in ('submitted', 'cancelled')
        self.status.config(text='● MONITORING ACTIVE' if active else 'NOT MONITORING', bg='#a92e27' if active else '#e7eee9', fg='white' if active else '#244333')
        self.indicator_ready = sharing
        camera_active = self.camera.status == 'active' and self.camera.permitted()
        self.camera_indicator.config(text='● CAMERA ACTIVE' if camera_active else ('CAMERA STOPPING — releasing device' if self.camera.running() else 'CAMERA OFF'), fg='#a92e27' if camera_active else '#244333')
        self.root.attributes('-topmost', active)
        self.accept_button.config(text='Stop monitoring (Esc)' if active else 'I consent — start sharing', state='normal' if active or (not finished and self.gate.session and self.client and self.client.connected and not self.consent_pending) else 'disabled')

    def toggle_compact(self):
        if not self.compact_ui:
            self.full_geometry = self.root.geometry()
            self.full_pack = [(w, w.pack_info()) for w in self.root.winfo_children() if w.winfo_manager() == 'pack']
            keep = {self.status, self.camera_indicator, self.compact_button, self.connection_status, self.monitoring_buttons, self.exam_button}
            for widget, _ in self.full_pack:
                if widget not in keep:
                    widget.pack_forget()
            self.root.minsize(440, 280)
            self.root.geometry(f'480x320+{max(0,self.root.winfo_screenwidth()-500)}+20')
            self.connection_status.config(wraplength=440)
            self.compact_button.config(text='Restore full consent / camera controls')
        else:
            for widget, _ in self.full_pack:
                widget.pack_forget()
            for widget, options in self.full_pack:
                widget.pack(**options)
            self.root.minsize(620, 620)
            self.root.geometry(self.full_geometry)
            self.connection_status.config(wraplength=600)
            self.compact_button.config(text='Compact monitoring panel')
        self.compact_ui = not self.compact_ui

    def camera_eligible(self, sid):
        return bool(sid and self.gate.session and self.gate.session['id'] == sid and self.client and self.client.connected and self.exam_state and self.exam_state.get('status') == 'started' and (self.attempt_until is None or time.monotonic() < self.attempt_until) and not self.quit.is_set())

    def camera_show(self, kind, data):
        if kind=='camera_state' and str(data).startswith('CAMERA STOPPED'):
            self.uploads.log.warning('camera_stopped reason=%s',str(data)[:180])
        if kind=='frame_captured':
            self.uploads.log.info('webcam_frame_captured valid=true')
            return
        # Only one preview pending: never accumulate camera frames in memory.
        if kind == 'camera_frame':
            with self.camera_frame_lock:
                self.camera_frame = data
                if not self.camera_frame_pending:
                    self.camera_frame_pending = True
                    self.ui.put((kind, None))
        else:
            self.ui.put((kind, data))

    def toggle_camera(self):
        if self.camera.running():
            self.camera.stop()
            self.camera_status.config(text='CAMERA STOPPING — releasing device', fg='#244333')
            sid = self.camera.session_id
            def notify():
                if self.client and self.client.connected:
                    self.server_call(self.client, 'camera-consent', {'sessionId': sid, 'accept': False}, timeout=4)
            self.consent_jobs.put(notify)
            return
        if not self.camera_consent.get():
            messagebox.showinfo('Camera consent', 'Read and select the separate camera consent checkbox first. Snapshots are optional.')
            return
        if self.clip_consent.get() and not self.snapshot_consent.get():
            messagebox.showinfo('Evidence consent','Event clips require both the snapshot and the separate silent clip consent checkbox.')
            return
        if self.camera_eligible(self.gate.session['id'] if self.gate.session else None):
            self.camera.lease_until = time.monotonic() + 6
            self.camera.start(self.gate.session['id'], self.snapshot_consent.get(), clips=self.clip_consent.get(),consent_policy=self.camera_policy.copy())

    def upload_eligible(self, scope):
        return bool(self.config and scope['url']==self.config['url'] and scope['deviceId']==self.config['id'] and self.camera.status=='active' and self.camera.permitted() and self.camera.snapshots_enabled and scope['sessionId']==self.camera.session_id and (scope.get('kind')!='incident-clip' or self.camera.clips_enabled))

    def transmit_evidence(self,name,payload):
        if name=='incident-clip':
            payload=dict(payload)
            payload['bytes']=base64.b64decode(payload.pop('encodedBytes'))
        return self.camera_transport(name,payload)

    def camera_call(self,name,payload):
        if name in ('proctor-event','incident-clip'):
            payload=dict(payload)
            dependency=payload.pop('dependency',None)
            if name=='incident-clip':
                payload['encodedBytes']=base64.b64encode(payload.pop('bytes')).decode('ascii')
            else:
                payload['deviceId']=self.config['id']
                payload['studentId']=self.config['id']
            return self.uploads.enqueue(name,payload,{'url':self.config['url'],'deviceId':self.config['id'],'sessionId':payload['sessionId'],'retentionDays':self.camera_policy['retentionDays'],'kind':name},dependency)
        return self.camera_transport(name,payload)

    def camera_transport(self,name,payload):
        if name=='incident-clip':
            if not self.camera.permitted():
                raise InterruptedError('Clip consent ended')
            response=requests.post(self.config['url']+'/api/student/incidents/'+payload['id']+'/clip',data=payload['bytes'],
                headers={'Authorization':'Bearer '+self.config['token'],'Content-Type':'video/webm',
                         'X-ExamOS-Camera-Grant':payload['grantId'],'X-Clip-Start':payload['startedAt'],'X-Clip-End':payload['endedAt']},timeout=12)
            try:
                result=response.json()
            except requests.exceptions.JSONDecodeError:
                raise ValueError('Server did not accept the event clip') from None
            if not response.ok:
                raise ValueError(result.get('error','Clip storage failed'))
            return result
        return self.server_call(self.client,name,payload,timeout=4,cancel=None if name=='camera-status' and payload.get('status')!='active' else self.camera.stop_event)

    def camera_option_changed(self):
        if self.camera.running():
            self.toggle_camera()

    def send_camera_check(self):
        if not self.camera.request_check():
            messagebox.showinfo('Camera check unavailable','Start your assigned examination and camera, enable the separate snapshot consent, and wait for CAMERA ACTIVE. A preview alone does not upload evidence. If a check is pending, wait for its result.')

    def close(self):
        if self.closing:
            return
        self.closing = True
        self.withdraw('window_closed')
        self.quit.set()
        if self.client and self.client.connected:
            client = self.client
            def finish():
                try:
                    if self.camera.thread:
                        self.camera.thread.join(timeout=8)
                    client.disconnect()
                finally:
                    self.ui.put(('closed', None))
            self.consent_jobs.put(finish)
        else:
            self.root.destroy()
        self.consent_jobs.put(None)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='ExamOS visible Windows student agent')
    parser.add_argument('--verify-ui', metavar='REPORT_JSON', help='Open the real enrollment UI, check visible widgets without connecting, write a build verification report, and exit')
    parser.add_argument('--verify-enrollment', metavar='REPORT_JSON', help='Verify a real code supplied in EXAMOS_ENROLLMENT_CODE against EXAMOS_TEST_URL using an isolated EXAMOS_CONFIG_PATH; never grant monitoring consent')
    parser.add_argument('--verify-evidence',metavar='REPORT_JSON',help='Visible, explicitly approved packaged webcam acceptance; requires isolated test environment')
    arguments = parser.parse_args()
    window = tk.Tk()
    application = Agent(window)
    enrollment_verification = {'passed':False}
    if arguments.verify_evidence:
        from evidence_verification import run
        run(window,application,arguments.verify_evidence)
    if arguments.verify_enrollment:
        if not os.environ.get('EXAMOS_CONFIG_PATH') or not os.environ.get('EXAMOS_TEST_URL') or not os.environ.get('EXAMOS_ENROLLMENT_CODE'):
            window.destroy()
            raise SystemExit('Enrollment verification requires an isolated credential path, a server URL, and a real teacher-issued code in the environment.')
        window.title('ExamOS — Enrollment verification (no monitoring)')
        application.url.delete(0,'end')
        application.url.insert(0,os.environ['EXAMOS_TEST_URL'])
        application.name.delete(0,'end')
        application.name.insert(0,os.environ.get('EXAMOS_DEVICE_LABEL','Packaged enrollment verification'))
        application.code.insert(0,os.environ['EXAMOS_ENROLLMENT_CODE'])
        verification_started=time.monotonic()
        stable_since=None
        def verify_real_enrollment():
            global stable_since
            connected=bool(application.client and application.client.connected)
            if connected and application.connection_status.cget('text').startswith('Connected'):
                if stable_since is None:
                    stable_since=time.monotonic()
            else:
                stable_since=None
            if application.last_error or time.monotonic()-verification_started>15 or (stable_since is not None and time.monotonic()-stable_since>=3):
                enrollment_verification.update(passed=bool(connected and not application.last_error and not application.gate.allowed()),packaged=bool(getattr(__import__('sys'),'frozen',False)),connected=connected,deviceId=application.config.get('id') if application.config else None,connectionLabel=application.connection_status.cget('text'),codeCleared=not bool(application.code.get()),monitoring=application.gate.allowed(),selectedTransport=application.client.transport() if connected else None,error=application.last_error)
                destination=Path(arguments.verify_enrollment).resolve()
                destination.parent.mkdir(parents=True,exist_ok=True)
                destination.write_text(json.dumps(enrollment_verification,indent=2),encoding='utf-8')
                application.close()
                return
            window.after(100,verify_real_enrollment)
        window.after(100,application.connect_button.invoke)
        window.after(200,verify_real_enrollment)
    if arguments.verify_ui:
        def verify_enrollment_interface():
            report = {'passed': False}
            try:
                window.update_idletasks()
                def visible(widget):
                    return bool(widget.winfo_ismapped() and widget.winfo_width() > 0 and widget.winfo_height() > 0
                                and widget.winfo_rooty() >= window.winfo_rooty()
                                and widget.winfo_rooty()+widget.winfo_height() <= window.winfo_rooty()+window.winfo_height()
                                and widget.winfo_rootx() >= window.winfo_rootx()
                                and widget.winfo_rootx()+widget.winfo_width() <= window.winfo_rootx()+window.winfo_width())
                checks = {
                    'window_displayed': bool(window.winfo_viewable()),
                    'server_url_entry_visible': visible(application.url),
                    'student_name_entry_visible': visible(application.name),
                    'enrollment_code_entry_visible': visible(application.code),
                    'connection_status_visible': visible(application.connection_status),
                    'enroll_connect_button_visible': visible(application.connect_button),
                    'consent_button_visible': visible(application.accept_button),
                    'examination_button_visible': visible(application.exam_button),
                    'escape_stop_shortcut': bool(window.bind('<Escape>')),
                    'single_consent_control': application.accept_button.cget('text') == 'I consent — start sharing',
                    'not_monitoring': application.status.cget('text') == 'NOT MONITORING' and not application.gate.allowed(),
                    'camera_controls_visible': visible(application.camera_button) and visible(application.snapshot_check) and visible(application.camera_status),
                    'clip_consent_visible_and_off': visible(application.clip_check) and not application.clip_consent.get(),
                    'camera_not_accessed': application.camera.thread is None and not application.camera_consent.get() and not application.snapshot_consent.get(),
                }
                from camera_monitor import Detector
                import numpy as np
                import av
                checks['vp8_encoder_available'] = av.Codec('libvpx','w').type == 'video'
                # Packaging smoke test only; no real camera is opened by this UI verifier.
                blank_counts = Detector().counts(np.zeros((480, 640, 3), dtype=np.uint8))
                checks['packaged_model_blank_frame_inference'] = blank_counts['personCount'] == 0 and blank_counts['phoneCount'] == 0
                application.toggle_compact()
                window.update_idletasks()
                checks['compact_panel_keeps_indicators_and_stop_control'] = visible(application.status) and visible(application.camera_indicator) and visible(application.accept_button) and visible(application.exam_button)
                application.toggle_compact()
                report = {'passed': all(checks.values()), 'packaged': bool(getattr(__import__('sys'), 'frozen', False)),
                          'window_title': window.title(), 'checks': checks,
                          'fields': ['Server URL (HTTPS on LAN)', 'Device / student label', 'One-use enrollment code']}
            except Exception as exc:
                report['error'] = str(exc)
            finally:
                destination = Path(arguments.verify_ui).resolve()
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.write_text(json.dumps(report, indent=2), encoding='utf-8')
                application.close()
        window.after(3000, verify_enrollment_interface)
    window.mainloop()
    if arguments.verify_enrollment and not enrollment_verification['passed']:
        raise SystemExit(1)
