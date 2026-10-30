"""Pure session/lease eligibility. No capture, network or platform imports."""
import threading
import time

class ConsentGate:
    def __init__(self):
        self.session = None
        self.accepted = None
        self.lease_until = 0
        self.lock = threading.RLock()
        self.stop_requested = threading.Event()

    def stop(self):
        # Interrupt eligibility immediately, even if a native grab is finishing.
        self.stop_requested.set()
        with self.lock:
            self.accepted = None
            self.lease_until = 0

    def allowed(self):
        with self.lock:
            return bool(not self.stop_requested.is_set() and self.session and self.accepted == self.session['id'] and time.monotonic() < self.lease_until)


def may_renew_lease(previous_until, request_started, grant_accepted, server_allowed=None, received_at=None):
    """Do not revive an expired lease or apply a negative reply to a newer grant."""
    return previous_until > max(request_started, received_at if received_at is not None else request_started) and (server_allowed is not False or grant_accepted > request_started)
