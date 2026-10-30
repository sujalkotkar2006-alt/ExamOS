"""Pure sustained-condition/cooldown rules; no sensors or inference dependencies."""
class EventGate:
    """One incident per continuous condition; two clear seconds and cooldown rearm it."""
    def __init__(self):
        self.since, self.last, self.latched, self.absent_since = {}, {}, set(), {}

    def eligible(self, category, present, now, threshold, cooldown):
        if not present:
            self.since.pop(category,None)
            self.absent_since.setdefault(category,now)
            if now-self.absent_since[category]>=2:
                self.latched.discard(category)
            return False
        self.absent_since.pop(category,None)
        self.since.setdefault(category,now)
        return category not in self.latched and now-self.since[category]>=threshold and now-self.last.get(category,-1000000)>=cooldown

    def commit(self, category, now):
        self.last[category]=now
        if category!='camera_check':
            self.latched.add(category)

