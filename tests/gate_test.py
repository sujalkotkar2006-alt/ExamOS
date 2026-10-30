import sys
import time
import unittest
import threading
from pathlib import Path
sys.path.insert(0, str(Path('agent').resolve()))
from monitoring_lifecycle import ConsentGate, may_renew_lease

class GateTests(unittest.TestCase):
    def test_consent_session_and_lease_all_required(self):
        gate = ConsentGate()
        self.assertFalse(gate.allowed())
        gate.session = {'id': 'session-a'}
        gate.lease_until = time.monotonic()+6
        self.assertFalse(gate.allowed())
        gate.accepted = 'session-b'
        self.assertFalse(gate.allowed())
        gate.accepted = 'session-a'
        self.assertTrue(gate.allowed())
        gate.lease_until = time.monotonic()-1
        self.assertFalse(gate.allowed())
        gate.lease_until = time.monotonic()+6
        gate.stop()
        self.assertFalse(gate.allowed())
        self.assertIsNone(gate.accepted)

    def test_lease_renewal_rejects_expiry_and_preserves_a_newer_grant(self):
        self.assertFalse(may_renew_lease(9,10,8,True))
        self.assertFalse(may_renew_lease(12,10,8,True,received_at=13))
        self.assertTrue(may_renew_lease(16,10,11,False,received_at=12))
        self.assertFalse(may_renew_lease(16,10,8,False))
        self.assertTrue(may_renew_lease(16,10,11,False))
        self.assertTrue(may_renew_lease(16,10,8,True))
        self.assertTrue(may_renew_lease(16,10,8,None))

    def test_stop_signal_preempts_an_in_progress_capture_lock(self):
        gate=ConsentGate()
        with gate.lock:
            stopped=threading.Event()
            worker=threading.Thread(target=lambda:(gate.stop(),stopped.set()))
            worker.start()
            self.assertTrue(gate.stop_requested.wait(1))
            self.assertFalse(stopped.is_set())
        worker.join(timeout=1)
        self.assertTrue(stopped.is_set())
        self.assertFalse(gate.allowed())

if __name__ == '__main__':
    unittest.main()
