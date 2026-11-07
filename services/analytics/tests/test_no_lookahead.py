"""Verdicts dated before day t must not change when data after t is removed (no lookahead)."""
import numpy as np

from pinpulse_analytics.detectors import Signals, diagnose
from pinpulse_analytics.synth import make_benchmark


def test_no_lookahead_on_onset():
    changed = 0; checked = 0
    for sig, truth in make_benchmark(5, 60):
        if truth.onset is None:
            continue
        full = diagnose(Signals(**sig))
        if full.drop is None or abs(full.onset_index - truth.onset) > 2:
            continue
        # truncate 14 days after the detected onset (the confirmation window) and re-run
        t = full.onset_index + 14
        if t >= len(sig["impressions"]):
            continue
        cut = {k: (v[:t] if isinstance(v, np.ndarray) else v) for k, v in sig.items()}
        part = diagnose(Signals(**cut))
        checked += 1
        if part.drop is None or part.onset_index != full.onset_index:
            changed += 1
    assert checked > 10
    assert changed / checked < 0.15, f"onset changed on truncation in {changed}/{checked} cases"
