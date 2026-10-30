"""Pure timing rules: no camera, model, media fixtures or incidents are created."""
import sys
from pathlib import Path
import unittest
sys.path.insert(0,str(Path('agent').resolve()))
from event_gate import EventGate


class GateTests(unittest.TestCase):
    def test_continuous_condition_never_repeats_after_cooldown(self):
        gate=EventGate()
        self.assertFalse(gate.eligible('phone_detected',True,0,2,30))
        self.assertTrue(gate.eligible('phone_detected',True,2,2,30))
        gate.commit('phone_detected',2)
        for stamp in (3,30,33,600):
            self.assertFalse(gate.eligible('phone_detected',True,stamp,2,30))

    def test_two_clear_seconds_and_configurable_cooldown_are_both_required(self):
        gate=EventGate()
        gate.eligible('phone_detected',True,0,2,60)
        gate.commit('phone_detected',2)
        gate.eligible('phone_detected',False,10,2,60)
        gate.eligible('phone_detected',False,11,2,60)
        self.assertFalse(gate.eligible('phone_detected',True,14,2,60))
        gate.eligible('phone_detected',False,20,2,60)
        gate.eligible('phone_detected',False,22,2,60)
        gate.eligible('phone_detected',True,23,2,60)
        self.assertFalse(gate.eligible('phone_detected',True,40,2,60))
        self.assertTrue(gate.eligible('phone_detected',True,62,2,60))

    def test_conditions_have_independent_cooldowns(self):
        gate=EventGate()
        gate.commit('phone_detected',2)
        self.assertFalse(gate.eligible('multiple_people',True,3,3,30))
        self.assertTrue(gate.eligible('multiple_people',True,6,3,30))


if __name__=='__main__':
    unittest.main()
