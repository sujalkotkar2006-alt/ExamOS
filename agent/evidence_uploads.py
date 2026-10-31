"""Bounded, user-DPAPI encrypted evidence outbox. Never captures or starts a camera."""
import hashlib
import json
import logging
from logging.handlers import RotatingFileHandler
import os
import sys
from pathlib import Path
import threading
import time
import uuid

IS_WINDOWS = sys.platform == 'win32'
if IS_WINDOWS:
    try:
        import win32crypt
    except ImportError:
        win32crypt = None
else:
    win32crypt = None

try:
    from cryptography.fernet import Fernet
except ImportError:
    Fernet = None


class EvidenceUploads:
    def __init__(self, directory, send, eligible, grant, show):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.send, self.eligible, self.grant, self.show = send, eligible, grant, show
        self.lock = threading.RLock()
        self.last = 'No uploads yet'
        self.receipts = {}
        self.log = logging.getLogger('ExamOS.evidence.'+str(self.directory))
        self.log.setLevel(logging.INFO)
        handler = RotatingFileHandler(self.directory/'upload.log', maxBytes=256000, backupCount=2, encoding='utf8')
        handler.setFormatter(logging.Formatter('%(asctime)s %(message)s'))
        self.log.addHandler(handler)
        threading.Thread(target=self.run, daemon=True).start()

    def _key(self):
        key_file = self.directory / '.key'
        if not key_file.exists() and Fernet:
            key_file.write_bytes(Fernet.generate_key())
            try:
                os.chmod(key_file, 0o600)
            except Exception:
                pass
        return key_file.read_bytes() if key_file.exists() else None

    def save(self, path, job):
        raw = json.dumps(job).encode()
        if IS_WINDOWS and win32crypt:
            encrypted = win32crypt.CryptProtectData(raw, 'ExamOS temporary evidence', None, None, None, 0)
        elif Fernet and self._key():
            encrypted = Fernet(self._key()).encrypt(raw)
        else:
            encrypted = raw
        temporary = path.with_suffix('.tmp')
        with open(temporary, 'wb') as out:
            out.write(encrypted)
            out.flush()
            os.fsync(out.fileno())
        os.replace(temporary, path)

    def load(self, path):
        content = path.read_bytes()
        if IS_WINDOWS and win32crypt:
            raw = win32crypt.CryptUnprotectData(content, None, None, None, 0)[1]
        elif Fernet and self._key():
            raw = Fernet(self._key()).decrypt(content)
        else:
            raw = content
        return json.loads(raw)

    def enqueue(self, name, payload, scope, dependency=None):
        with self.lock:
            paths = list(self.directory.glob('*.queue'))
            if len(paths) >= 24 or sum(p.stat().st_size for p in paths) > 32*1024*1024:
                raise ValueError('Encrypted evidence queue full. No capture accepted; resolve pending uploads first.')
            key = payload.get('clientEventId') if name == 'proctor-event' else str(uuid.uuid4())
            job = dict(name=name, payload=payload, scope=scope, dependency=dependency,
                       expires=time.time()+min(900, int(scope.get('retentionDays', 7))*86400), attempts=0, next=0)
            self.save(self.directory/(key+'.queue'), job)
            self.log.info('snapshot_created' if name=='proctor-event' else 'clip_created')
            self.last = 'Evidence encrypted and queued'
        return {'ok': True, 'queued': True, 'id': key, 'clipExpected': payload.get('clipExpected', False)}

    def retry(self):
        with self.lock:
            for path in self.directory.glob('*.queue'):
                job=self.load(path)
                job.update(attempts=0, next=0)
                self.save(path,job)

    def status(self):
        return self.last, len(list(self.directory.glob('*.queue')))

    def run(self):
        while True:
            if True:
                for path in list(self.directory.glob('*.queue')):
                    try:
                        job=self.load(path)
                        if time.time() > job['expires']:
                            path.unlink()
                            self.last='Queued evidence expired under the temporary retention policy'
                            self.log.warning('queue_expired')
                            self.show('evidence_error',self.last)
                            continue
                        if job['attempts'] >= 4 or time.time() < job['next'] or not self.eligible(job['scope']):
                            continue
                        payload=dict(job['payload'])
                        payload.pop('grantId',None)
                        if job.get('dependency'):
                            receipt=self.receipts.get(job['dependency'])
                            receipt_path=self.directory/(job['dependency']+'.receipt')
                            if receipt is None and receipt_path.exists():
                                receipt=self.load(receipt_path)
                            if not receipt:
                                continue
                            payload['id']=receipt['id']
                        payload['grantId']=self.grant()
                        job['attempts']+=1
                        self.last='Uploading (attempt %s/4)' % job['attempts']
                        self.log.info('upload_started kind=%s attempt=%s',job['name'],job['attempts'])
                        try:
                            result=self.send(job['name'],payload)
                            self.log.info('backend_response status=%s ok=%s',result.get('status',200 if result.get('ok') else 'rejected'),bool(result.get('ok')))
                            if not result.get('ok') or result.get('throttled'):
                                raise RuntimeError('Backend status %s; %s' % (result.get('status','rejected'),result.get('error','rate limited')))
                            if job['name']=='proctor-event' and payload.get('jpeg') and not result.get('hasEvidence'):
                                raise RuntimeError('Backend did not confirm stored snapshot')
                            if job['name']=='proctor-event':
                                result['captureSha256']=hashlib.sha256(__import__('base64').b64decode(payload.get('jpeg',''))).hexdigest()
                            self.receipts[path.stem]=result
                            self.save(path.with_suffix('.receipt'),result)
                            path.unlink()
                            self.last='Backend confirmed stored evidence'
                            self.log.info('upload_succeeded event=%s evidence=%s',result.get('id'),result.get('evidenceId'))
                            self.show('snapshot_saved' if job['name']=='proctor-event' else 'evidence_saved',result.get('evidenceId') or payload.get('id') or result.get('id'))
                        except Exception as exc:
                            # Exception text may contain URLs/credentials: only log its type and server status.
                            job['next']=time.time()+2**job['attempts']
                            self.save(path,job)
                            self.last='Upload failed; encrypted evidence retained. '+('Retry queued' if job['attempts']<4 else 'Use Retry pending uploads')
                            self.log.warning('upload_failed type=%s attempt=%s',type(exc).__name__,job['attempts'])
                            self.show('evidence_error',self.last)
                    except Exception as exc:
                        self.last='Evidence queue error: '+type(exc).__name__
                        self.log.error('queue_error type=%s',type(exc).__name__)
                # Receipt files contain no media; bound them to the same 15 minute temporary lifetime.
                for path in self.directory.glob('*.receipt'):
                    if time.time()-path.stat().st_mtime>900:
                        path.unlink()
                        self.receipts.pop(path.stem,None)
            time.sleep(.25)
