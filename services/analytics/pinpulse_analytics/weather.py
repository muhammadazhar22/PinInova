"""Platform "weather" index from voluntary user reports (SPEC-030).

policy: PA-06 (WEATHER_SOURCE=user_reports) - inputs are counts of users who REPORTED a drop on a day and the
number of active reporters; no Pinterest API data from any account enters this module.

Null (no platform event): k ~ Binomial(n, p0), or Beta-Binomial(n, p0*phi, (1-p0)*phi) when reporters share
shocks (niches, news). phi is the caller's value, else a method-of-moments estimate from the provided history
(days that are themselves extreme under the binomial are trimmed first), else binomial if history is short.

  tail_p  = P(K >= k | null)
  log_bf  = log B(a + k, b + n - k) - log B(a, b) - log m_null(k)        (alternative prior Beta(a, b) = Beta(1, 20))
  level   = platform_wide if tail_p < 0.001 and k/n >= 0.10; elevated if tail_p < 0.01 or k/n >= 0.05;
            normal otherwise; days with fewer than 5 active reporters are 'normal' with insufficient = true.
"""
from __future__ import annotations

from math import lgamma, log

import numpy as np
from scipy.stats import betabinom, binom

ALT_A, ALT_B = 1.0, 20.0
MIN_REPORTERS = 5
MIN_HISTORY_DAYS = 14


def _log_beta(a: float, b: float) -> float:
    return lgamma(a) + lgamma(b) - lgamma(a + b)


def estimate_phi(k: np.ndarray, n: np.ndarray, p0: float) -> float | None:
    """Beta-Binomial precision by method of moments around the null mean p0 (None = no overdispersion found or
    too little history). rho = 1 / (1 + phi); E[X^2] = sum(1 + (n_i - 1) rho)."""
    ok = n >= MIN_REPORTERS
    k, n = k[ok], n[ok]
    if len(k) == 0:
        return None
    keep = binom.sf(k - 1, n, p0) >= 0.001          # trim candidate event days
    k, n = k[keep], n[keep]
    if len(k) < MIN_HISTORY_DAYS or np.sum(n - 1) <= 0:
        return None
    x2 = float(np.sum((k - n * p0) ** 2 / (n * p0 * (1 - p0))))
    rho = (x2 - len(k)) / float(np.sum(n - 1))
    if rho <= 0:
        return None
    rho = min(rho, 0.99)
    return 1.0 / rho - 1.0


def day_stats(k: int, n: int, p0: float, phi: float | None) -> tuple[float, float, float]:
    """(fraction, log_bf, tail_p) for one day."""
    if n <= 0:
        return 0.0, 0.0, 1.0
    frac = k / n
    if phi is None:
        null = k * log(p0) + (n - k) * log(1 - p0)
        tail = float(binom.sf(k - 1, n, p0))
    else:
        a0, b0 = p0 * phi, (1 - p0) * phi
        null = _log_beta(a0 + k, b0 + n - k) - _log_beta(a0, b0)
        tail = float(betabinom.sf(k - 1, n, a0, b0))
    alt = _log_beta(ALT_A + k, ALT_B + n - k) - _log_beta(ALT_A, ALT_B)
    return frac, float(alt - null), min(max(tail, 0.0), 1.0)


def weather(windows: list[tuple[str, int, int]], base_rate: float = 0.0017, phi: float | None = None) -> dict:
    k = np.array([w[1] for w in windows], dtype=float)
    n = np.array([w[2] for w in windows], dtype=float)
    used_phi = phi if phi is not None else estimate_phi(k, n, base_rate)
    days = []
    for date, kk, nn in windows:
        frac, lbf, tail = day_stats(kk, nn, base_rate, used_phi)
        if nn < MIN_REPORTERS:
            level, insufficient = "normal", True
        elif tail < 0.001 and frac >= 0.10:
            level, insufficient = "platform_wide", False
        elif tail < 0.01 or frac >= 0.05:
            level, insufficient = "elevated", False
        else:
            level, insufficient = "normal", False
        days.append({"date": date, "fraction": frac, "log_bf": lbf, "tail_p": tail, "level": level,
                     "insufficient": insufficient})
    return {"days": days, "phi": used_phi, "model": "beta_binomial" if used_phi is not None else "binomial"}


def weather_log_bayes_factor(hits: int, n_accounts: int, base_rate: float = 0.0017) -> float:
    """Binomial-null log BF (kept for callers of the v0 function)."""
    return day_stats(hits, n_accounts, base_rate, None)[1]
