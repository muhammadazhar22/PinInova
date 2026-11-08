import json
import pathlib

import numpy as np

from pinpulse_analytics.benchmark import ABSOLUTE_FLOOR, run
from pinpulse_analytics.detectors import (
    cusum_drop,
    diagnose,
    fit_shape,
    pelt_mean_shift,
    pelt_rank,
    pin_contributions,
    quantify_drop,
    rate_shift_log_bayes_factor,
    rate_test,
)
from pinpulse_analytics.schemas import DiagnoseRequest
from pinpulse_analytics.weather import weather_log_bayes_factor

BASELINE = pathlib.Path(__file__).resolve().parents[1] / "benchmark_baseline.json"


def test_pelt_finds_single_step():
    rng = np.random.default_rng(1)
    x = np.concatenate([rng.poisson(1000, 45), rng.poisson(100, 45)])
    assert any(abs(c - 45) <= 2 for c in pelt_mean_shift(x))
    assert any(abs(c - 45) <= 2 for c in pelt_rank(np.log1p(x)))


def test_pelt_quiet_on_flat_series():
    rng = np.random.default_rng(2)
    assert pelt_mean_shift(rng.poisson(1000, 90)) == []


def test_pelt_ignores_weekly_seasonality():
    t = np.arange(90)
    assert pelt_mean_shift(1000 * (1 + 0.15 * np.sin(2 * np.pi * t / 7))) == []


def test_quantify_drop_ratio():
    b, a, ratio = quantify_drop(np.array([1000.0] * 30 + [100.0] * 30), 30)
    assert (b, a) == (1000.0, 100.0) and abs(ratio - 0.1) < 1e-12


def test_rate_shift_bf_sign():
    assert rate_shift_log_bayes_factor(400, 10000, 40, 1000) <= 1.0
    assert rate_shift_log_bayes_factor(400, 10000, 20, 1000) > 1.0


def test_rate_test_verdicts():
    n = np.full(42, 2000.0)
    k_same = np.full(42, 40.0)
    k_fell = np.concatenate([np.full(28, 40.0), np.full(14, 16.0)])
    pre, post = slice(0, 28), slice(28, 42)
    assert rate_test(k_same, n, pre, post).verdict == "stable"
    r = rate_test(k_fell, n, pre, post)
    assert r.verdict == "changed" and r.direction == "fell"
    assert rate_test(k_fell, np.full(42, 20.0), pre, post).verdict == "insufficient"  # 280 post impressions


def test_pin_contributions_sum_to_total():
    rows = pin_contributions({"a": 1000, "b": 500, "c": 100}, {"a": 100, "b": 480, "c": 120})
    assert abs(sum(r[2] for r in rows) - 1.0) < 1e-9 and rows[0][0] == "a"


def test_weather_bf_grows_with_hits():
    assert weather_log_bayes_factor(40, 100) > weather_log_bayes_factor(3, 100)


def test_shape_step_vs_fade():
    t = np.arange(70)
    step = np.where(t < 40, 8.0, 6.5)
    fade = np.where(t < 40, 8.0, np.maximum(8.0 - 0.2 * (t - 40), 6.5))
    rng = np.random.default_rng(0)
    noise = rng.normal(0, 0.05, 70)
    assert fit_shape(step + noise, 40, 70, 0.05).shape == "step"
    f = fit_shape(fade + noise, 44, 70, 0.05)
    assert f.shape == "fade" and abs(f.start - 40) <= 2


def test_cusum_alarms_after_drop_not_before():
    x = np.concatenate([np.full(60, 1000.0), np.full(10, 200.0)])
    r = cusum_drop(x)
    assert r.alarms and 60 <= r.alarms[0] <= 62 and r.active_at_end


def test_diagnose_flat_returns_none():
    rng = np.random.default_rng(3)
    req = DiagnoseRequest(impressions=rng.poisson(5000, 90).astype(float).tolist(),
                          outbound_clicks=rng.poisson(150, 90).astype(float).tolist())
    out = diagnose(req)
    assert out.status == "none" and out.drop is None


def test_every_score_contribution_has_evidence():
    from pinpulse_analytics.benchmark import run_account
    from pinpulse_analytics.synth import iter_benchmark
    for acc in iter_benchmark(5, 30):
        out = run_account(acc)
        if out.status == "drop":
            assert out.evidence[0].code == "drop_detected"
            assert len(out.evidence) >= 3


def test_benchmark_does_not_regress():
    r = run(seed=7, n=300, lead=False)
    base = json.loads(BASELINE.read_text())["score"] if BASELINE.exists() else 0.0
    assert r["score"] >= base - 0.01, f"benchmark score {r['score']:.3f} < baseline {base:.3f}"
    assert r["score"] >= ABSOLUTE_FLOOR
    assert r["onset_f1"] > r["naive_rule_f1"]
