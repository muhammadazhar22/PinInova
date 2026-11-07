import json
import pathlib

import numpy as np
import pytest

from pinpulse_analytics.benchmark import run
from pinpulse_analytics.detectors import (
    Signals, diagnose, pelt_mean_shift, pin_contributions, quantify_drop,
    rate_shift_log_bayes_factor, weather_log_bayes_factor,
)

BASELINE = pathlib.Path(__file__).resolve().parents[1] / "benchmark_baseline.json"


def test_pelt_finds_single_step():
    rng = np.random.default_rng(1)
    x = np.concatenate([rng.poisson(1000, 45), rng.poisson(100, 45)])
    cps = pelt_mean_shift(x)
    assert any(abs(c - 45) <= 2 for c in cps)


def test_pelt_quiet_on_flat_series():
    rng = np.random.default_rng(2)
    x = rng.poisson(1000, 90)
    assert pelt_mean_shift(x) == []


def test_pelt_ignores_weekly_seasonality():
    t = np.arange(90)
    x = 1000 * (1 + 0.15 * np.sin(2 * np.pi * t / 7))
    assert pelt_mean_shift(x) == []


def test_quantify_drop_ratio():
    x = np.array([1000.0] * 30 + [100.0] * 30)
    d = quantify_drop(x, 30)
    assert 0.09 < d.ratio < 0.11


def test_rate_shift_bf_sign():
    # same CTR before/after -> BF <= 0 ; CTR halves -> BF > 0
    assert rate_shift_log_bayes_factor(400, 10000, 40, 1000) <= 1.0
    assert rate_shift_log_bayes_factor(400, 10000, 20, 1000) > 1.0


def test_pin_contributions_sum_to_total():
    before = {"a": 1000, "b": 500, "c": 100}
    after = {"a": 100, "b": 480, "c": 120}
    rows = pin_contributions(before, after)
    assert abs(sum(r[2] for r in rows) - 1.0) < 1e-9
    assert rows[0][0] == "a"


def test_weather_bf_grows_with_hits():
    assert weather_log_bayes_factor(40, 100) > weather_log_bayes_factor(3, 100)


def test_diagnose_flat_returns_none():
    rng = np.random.default_rng(3)
    s = Signals(impressions=rng.poisson(5000, 90).astype(float), outbound_clicks=rng.poisson(150, 90).astype(float))
    assert diagnose(s).drop is None


def test_benchmark_does_not_regress():
    r = run(seed=7, n=300)
    base = json.loads(BASELINE.read_text())["score"] if BASELINE.exists() else 0.0
    assert r["score"] >= base - 0.01, f"benchmark score {r['score']:.3f} < baseline {base:.3f}"
