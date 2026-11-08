"""Property tests (Hypothesis) for the diagnose pipeline."""
import numpy as np
from hypothesis import given, settings
from hypothesis import strategies as st

from pinpulse_analytics.detectors import diagnose
from pinpulse_analytics.schemas import DiagnoseRequest


def _series(seed: int, n: int, level: float, amp: float, onset: int | None, drop: float, r: float | None):
    rng = np.random.default_rng(seed)
    t = np.arange(n)
    mean = level * (1 + amp * np.sin(2 * np.pi * t / 7 + rng.uniform(0, 6.28)))
    if onset is not None:
        mean = mean * np.where(t >= onset, 1 - drop, 1.0)
    if r is not None:
        mean = mean * rng.gamma(r, 1 / r, n)
    x = rng.poisson(mean).astype(float)
    return x, rng.binomial(x.astype(int), 0.02).astype(float)


def _diag(x, c, **kw):
    return diagnose(DiagnoseRequest(impressions=x.tolist(), outbound_clicks=c.tolist(), **kw))


@settings(max_examples=40, deadline=None, derandomize=True)
@given(seed=st.integers(0, 10**6), n=st.integers(28, 200), level=st.floats(200, 1e6), amp=st.floats(0, 0.4))
def test_no_confirmed_drop_on_stationary_seasonal_noise(seed, n, level, amp):
    x, c = _series(seed, n, level, amp, None, 0.0, None)
    assert _diag(x, c).status != "drop"


def test_false_alarm_rate_on_overdispersed_noise_within_target():
    fired = sum(_diag(*_series(s, 90, 3000, 0.15, None, 0.0, 8.0)).status == "drop" for s in range(200))
    assert fired / 200 <= 0.05


@settings(max_examples=40, deadline=None, derandomize=True)
@given(seed=st.integers(0, 10**6), level=st.floats(500, 1e6), drop=st.floats(0.7, 0.97),
       onset=st.integers(20, 75), amp=st.floats(0, 0.3))
def test_large_drops_found_on_poisson_series(seed, level, drop, onset, amp):
    x, c = _series(seed, 90, level, amp, onset, drop, None)
    out = _diag(x, c)
    assert out.status == "drop" and abs(out.onset_index - onset) <= 2


def test_recall_on_70pct_drops_with_overdispersion():
    hits = 0
    for s in range(100):
        rng = np.random.default_rng(s)
        onset = int(rng.integers(20, 75))
        drop = float(rng.uniform(0.7, 0.97))
        out = _diag(*_series(s, 90, float(np.exp(rng.uniform(6, 11))), 0.15, onset, drop, 10.0))
        hits += out.status == "drop" and abs(out.onset_index - onset) <= 2
    assert hits / 100 >= 0.9


@settings(max_examples=25, deadline=None, derandomize=True)
@given(seed=st.integers(0, 10**6), k=st.sampled_from([3.0, 10.0, 100.0]), drop=st.floats(0.0, 0.95),
       onset=st.integers(20, 75))
def test_scale_invariance(seed, k, drop, onset):
    x, c = _series(seed, 90, 2000, 0.1, onset, drop, 10.0)
    a = _diag(x, c)
    b = _diag(x * k, c * k)
    assert a.status == b.status
    assert a.onset_index == b.onset_index
