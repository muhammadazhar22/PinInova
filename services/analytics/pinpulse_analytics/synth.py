"""Synthetic Pinterest-like series with known ground truth.

The benchmark the agent loop climbs: generate N accounts with labelled cliffs,
run the detector, score precision/recall on onset (±2 days) and class accuracy.
Model: daily impressions ~ NegBin(mean = level * weekly_seasonality * decay_mix, dispersion r),
with optional cliff at t0 multiplying the mean by (1 - drop).
"""
from __future__ import annotations

from dataclasses import dataclass

import numpy as np


@dataclass
class Truth:
    onset: int | None
    drop: float | None
    cls: str | None   # one of the CauseClass labels or None


def _negbin(rng: np.random.Generator, mean: np.ndarray, r: float) -> np.ndarray:
    p = r / (r + np.maximum(mean, 1e-9))
    return rng.negative_binomial(r, p)


def make_account(rng: np.random.Generator, n: int = 90, level: float | None = None, dispersion: float = 8.0,
                 cliff: bool = True) -> tuple[dict, Truth]:
    level = level or float(np.exp(rng.uniform(np.log(200), np.log(50_000))))
    t = np.arange(n)
    weekly = 1 + 0.15 * np.sin(2 * np.pi * t / 7 + rng.uniform(0, 2 * np.pi))
    trend = np.exp(rng.normal(0, 0.002) * t)
    mean = level * weekly * trend
    ctr = rng.uniform(0.01, 0.06)
    truth = Truth(None, None, None)
    new_mean = mean * 0.25
    old_mean = mean * 0.75
    if cliff and rng.uniform() < 0.8:
        onset = int(rng.integers(20, n - 15))
        drop = float(rng.uniform(0.5, 0.97))
        cls = rng.choice(["A_enforcement", "B_quality", "C_behavioural", "D_platform", "E_decay"],
                         p=[0.2, 0.15, 0.2, 0.35, 0.1])
        mult = np.where(t >= onset, 1 - drop, 1.0)
        if cls == "C_behavioural":
            # new Pins die; old Pins keep most of their reach, so the total drop is moderate
            drop = float(rng.uniform(0.3, 0.6))
            m_old = (1 - drop - 0.25 * 0.02) / 0.75
            new_mean = new_mean * np.where(t >= onset, 0.02, 1.0)
            old_mean = old_mean * np.where(t >= onset, m_old, 1.0)
            mean = new_mean + old_mean
        elif cls == "E_decay":
            # one viral Pin peaks at `onset` then fades: a smooth decay, not a step
            viral = np.where(t >= onset - 10, level * 2.0 * np.exp(-np.maximum(t - onset, 0) / 6.0), 0.0)
            mean = mean + viral
            new_mean, old_mean = mean * 0.25, mean * 0.75
        else:
            mean = mean * mult
            new_mean, old_mean = mean * 0.25, mean * 0.75
            if cls == "B_quality":
                ctr_after = ctr * 0.6  # content quality also hurts CTR
            elif cls == "A_enforcement" or cls == "D_platform":
                ctr_after = ctr        # pure distribution cut: CTR unchanged
        truth = Truth(onset, drop, str(cls))
    impressions = _negbin(rng, mean, dispersion)
    ctr_series = np.full(n, ctr)
    if truth.cls == "B_quality":
        ctr_series[truth.onset:] = ctr * 0.6
    clicks = rng.binomial(impressions, ctr_series)
    new_impr = _negbin(rng, new_mean, dispersion)
    old_impr = _negbin(rng, old_mean, dispersion)
    signals = dict(
        impressions=impressions.astype(float), outbound_clicks=clicks.astype(float),
        new_pins_impressions=new_impr.astype(float), old_pins_impressions=old_impr.astype(float),
        # Side signals are NOISY and INCOMPLETE on purpose: each true signal is observed only part of the
        # time, and each also fires spuriously on other classes, so the classifier cannot read the label off them.
        domain_block_error=bool((truth.cls == "A_enforcement" and rng.uniform() < 0.35) or rng.uniform() < 0.04),
        visit_site_demoted=bool((truth.cls == "B_quality" and rng.uniform() < 0.35) or rng.uniform() < 0.06),
        bulk_upload_or_ad_prefix=bool((truth.cls == "C_behavioural" and rng.uniform() < 0.4) or rng.uniform() < 0.08),
        duplicate_url_rate_14d=float(rng.uniform(0.5, 0.9)) if (truth.cls == "C_behavioural" and rng.uniform() < 0.4) or rng.uniform() < 0.05 else float(rng.uniform(0, 0.3)),
        # v1 has no pooled peer data (Pinterest authorization pending); the weather signal is absent.
        peers_hit_fraction=None,
    )
    return signals, truth


def make_benchmark(seed: int = 7, n_accounts: int = 300) -> list[tuple[dict, Truth]]:
    rng = np.random.default_rng(seed)
    return [make_account(rng) for _ in range(n_accounts)]
