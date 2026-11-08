"""Verdicts dated before day t must not change when data after t is removed (no lookahead)."""
import numpy as np
from hypothesis import given, settings
from hypothesis import strategies as st

from pinpulse_analytics.benchmark import run_account
from pinpulse_analytics.detectors import cusum_drop, early_warning
from pinpulse_analytics.synth import iter_benchmark


@settings(max_examples=40, deadline=None, derandomize=True)
@given(seed=st.integers(0, 10_000), cut=st.integers(30, 89), drop=st.floats(0.0, 0.95))
def test_cusum_is_strictly_causal(seed, cut, drop):
    rng = np.random.default_rng(seed)
    t = np.arange(90)
    x = rng.poisson(2000 * np.where(t >= 50, 1 - drop, 1.0)).astype(float)
    full = cusum_drop(x)
    part = cusum_drop(x[:cut])
    assert [a for a in full.alarms if a < cut] == part.alarms
    assert np.array_equal(full.stat[:cut], part.stat)


def test_early_warning_uses_only_past_data():
    acc = next(a for a in iter_benchmark(7, 60) if a.truth.onset is not None and a.truth.onset < 70)
    x = np.asarray(acc.request_at()["impressions"], dtype=float)
    for t in range(acc.truth.onset, acc.truth.onset + 8):
        w = early_warning(x[: t + 1], 0)
        if w is not None:
            assert w[0] <= t and w[1] <= t


def test_onset_stable_under_truncation():
    """Offline steps (STL, PELT) refit on the shorter series, so the date may move by a day; it must stay within
    the +/-2-day tolerance and the drop must stay confirmed. The online CUSUM above is exactly causal."""
    changed = exact = checked = 0
    for acc in iter_benchmark(5, 80):
        if acc.truth.onset is None:
            continue
        full = run_account(acc)
        if full.status != "drop" or abs(full.onset_index - acc.truth.onset) > 2:
            continue
        t = full.onset_index + 14
        if t >= acc.n:
            continue
        part = run_account(acc, t_end=t)
        checked += 1
        exact += part.status == "drop" and part.onset_index == full.onset_index
        if part.status != "drop" or abs(part.onset_index - full.onset_index) > 2:
            changed += 1
    assert checked > 10
    assert changed / checked < 0.10, f"onset moved > 2 days on truncation in {changed}/{checked} cases"
    assert exact / checked > 0.5
