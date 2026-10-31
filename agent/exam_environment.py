"""Limited Edge kiosk. Never changes Windows policies, hooks keys, or kills other browsers."""
import os
import subprocess
import tempfile
import shutil
import threading
from pathlib import Path
import psutil


class ExamEnvironment:
    def __init__(self):
        self.process = None
        self.profile = None
        self.lock = threading.RLock()

    def open(self, url):
        with self.lock:
            self._open(url)

    def _open(self, url):
        self.close()
        browser_bin = None
        # Windows Edge candidates
        candidates = [Path(os.environ.get(env, '')) / 'Microsoft/Edge/Application/msedge.exe'
                      for env in ('PROGRAMFILES(X86)', 'PROGRAMFILES', 'LOCALAPPDATA')]
        for p in candidates:
            if p.is_file():
                browser_bin = str(p)
                break
        # Linux / cross-platform browser candidates
        if not browser_bin:
            for name in ('microsoft-edge', 'google-chrome', 'chromium', 'chromium-browser', 'msedge'):
                found = shutil.which(name)
                if found:
                    browser_bin = found
                    break
        if browser_bin is None:
            raise ValueError('A Chromium-based browser (Edge, Chrome, Chromium) is required for the dedicated examination window. Use browser mode or install Edge/Chrome.')
        self.profile = tempfile.mkdtemp(prefix='examos-exam-')
        self.process = subprocess.Popen([browser_bin, '--user-data-dir=' + self.profile,
            '--kiosk', url, '--edge-kiosk-type=fullscreen', '--no-first-run',
            '--kiosk-idle-timeout-minutes=0'])

    def owns(self, pid):
        if not self.process or self.process.poll() is not None:
            return False
        try:
            root = psutil.Process(self.process.pid)
            return pid == root.pid or any(p.pid == pid for p in root.children(recursive=True))
        except psutil.Error:
            return False

    def close(self):
        with self.lock:
            self._close()

    def _close(self):
        process, profile = self.process, self.profile
        self.process = None
        self.profile = None
        if process and process.poll() is None:
            try:
                parent = psutil.Process(process.pid)
                if '--user-data-dir=' + profile not in parent.cmdline():
                    return  # Never terminate a PID reused by an unrelated application.
                children = parent.children(recursive=True)
                for child in children:
                    try:
                        child.terminate()
                    except psutil.Error:
                        pass
                parent.terminate()
            except psutil.Error:
                pass
        if profile:
            def cleanup():
                # Only the exact newly-created private temporary profile is eligible for removal.
                target = Path(profile).resolve()
                expected = Path(tempfile.gettempdir()).resolve()
                if target.parent != expected or not target.name.startswith('examos-exam-'):
                    return
                if process:
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        return
                try:
                    shutil.rmtree(target)
                except OSError:
                    pass
            threading.Thread(target=cleanup, daemon=True).start()
