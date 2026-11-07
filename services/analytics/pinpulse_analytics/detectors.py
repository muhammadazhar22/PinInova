"""PinPulse detection core (v1).

Pure functions over daily count series. No I/O, no Pinterest calls.
Designed to be driven by the synthetic benchmark in `synth.py` so that
agent loops have an objective score to improve.

Series convention: numpy arrays of daily values, oldest first, length <= 90.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from math import lgamma, log, sqrt
from typing import Literal

import numpy as np

CauseClass = Literal["A_enforcement", "B_quality", "C_behavioural", "D_platform", "E_decay", "M_measurement"]


# --------------------------------------------------------------------------- #
# 1. Changepoint detection on log-counts (binary segmentation / PELT-style)
# --------------------------------------------------------------------------- #

def _segment_cost(y: np.ndarray) -> float:
    """Gaussian mean-shift cost on log1p counts: sum of squared deviations."""
    if len(y) == 0:
        return 0.0
    return float(np.sum((y - y.mean()) ** 2))


def pelt_mean_shift(x: np.ndarray, penalty: float | None = None, min_size: int = 5) -> list[int]:
    """PELT (Killick, Fearnhead & Eckley 2012) for mean shifts in log1p(x).

    Cost: C(y) = sum (y - mean)^2 ; objective: sum_i C(seg_i) + beta * (#changepoints).
    Default beta = 2 * sigma^2 * log(n) (BIC-like) with sigma from the MAD of first differences,
    which is robust to the very shift we are looking for.
    Returns changepoint indices (start index of each new segment).
    O(n^2) worst case, fine for n <= 90.
    """
    y = np.log1p(np.asarray(x, dtype=float))
    n = len(y)
    if n < 2 * min_size:
        return []
    if penalty is None:
        d = np.diff(y)
        mad = np.median(np.abs(d - np.median(d))) * 1.4826 / sqrt(2) if len(d) else 0.0
        sigma = max(mad, 0.05)
        penalty = 2.0 * sigma**2 * log(n)
    # cumulative sums for O(1) segment cost
    cs = np.concatenate([[0.0], np.cumsum(y)])
    cs2 = np.concatenate([[0.0], np.cumsum(y * y)])

    def cost(a: int, b: int) -> float:  # cost of y[a:b]
        m = b - a
        if m <= 0:
            return 0.0
        s = cs[b] - cs[a]
        return float(cs2[b] - cs2[a] - s * s / m)

    F = np.full(n + 1, np.inf)
    F[0] = -penalty
    last = np.zeros(n + 1, dtype=int)
    candidates = [0]
    for t in range(min_size, n + 1):
        best, arg = np.inf, 0
        for s in candidates:
            if t - s < min_size:
                continue
            v = F[s] + cost(s, t) + penalty
            if v < best:
                best, arg = v, s
        F[t], last[t] = best, arg
        # PELT pruning
        candidates = [s for s in candidates if F[s] + cost(s, t) <= F[t]] + [t]
    cps: list[int] = []
    t = n
    while t > 0:
        s = last[t]
        if s > 0:
            cps.append(int(s))
        t = s
    return sorted(cps)


# --------------------------------------------------------------------------- #
# 2. Drop quantification
# --------------------------------------------------------------------------- #

@dataclass
class Drop:
    onset_index: int
    before_mean: float
    after_mean: float
    ratio: float  # after/before
    log_ratio: float


def quantify_drop(x: np.ndarray, cp: int, window: int = 14) -> Drop:
    x = np.asarray(x, dtype=float)
    before = x[max(0, cp - window):cp]
    after = x[cp:cp + window]
    b, a = float(np.median(before)) if len(before) else 0.0, float(np.median(after)) if len(after) else 0.0
    ratio = (a + 1) / (b + 1)
    return Drop(cp, b, a, ratio, float(np.log(ratio)))


# --------------------------------------------------------------------------- #
# 3. Engagement-rate stability test (Beta-Binomial, before vs after)
# --------------------------------------------------------------------------- #

def _log_beta(a: float, b: float) -> float:
    return lgamma(a) + lgamma(b) - lgamma(a + b)


def rate_shift_log_bayes_factor(k1: int, n1: int, k2: int, n2: int, alpha: float = 1.0, beta: float = 1.0) -> float:
    """log BF of 'two different rates' vs 'one shared rate' for clicks k over impressions n.

    Beta(alpha,beta) prior on the rate. Positive => evidence the rate changed.
    Used as: impressions collapse but log BF <= 0  ->  distribution cut (class B/D), not content quality.
    """
    if n1 == 0 or n2 == 0:
        return 0.0
    same = _log_beta(alpha + k1 + k2, beta + (n1 - k1) + (n2 - k2)) - _log_beta(alpha, beta)
    diff = (_log_beta(alpha + k1, beta + n1 - k1) - _log_beta(alpha, beta)) + (
        _log_beta(alpha + k2, beta + n2 - k2) - _log_beta(alpha, beta)
    )
    return diff - same


# --------------------------------------------------------------------------- #
# 4. Top-Pin decomposition of an account-level drop
# --------------------------------------------------------------------------- #

def pin_contributions(pin_before: dict[str, float], pin_after: dict[str, float]) -> list[tuple[str, float, float]]:
    """Share of the total account drop attributable to each Pin (additive, exact for sums).

    Returns [(pin_id, delta, share_of_total_drop)] sorted by delta ascending (biggest losses first).
    Flags the 'one viral Pin fading' case: if the top contributor explains > 60% of the drop
    and the remaining Pins' aggregate is flat (|delta| < 15%), classify E_decay.
    """
    ids = set(pin_before) | set(pin_after)
    deltas = {i: pin_after.get(i, 0.0) - pin_before.get(i, 0.0) for i in ids}
    total = sum(deltas.values())
    out = []
    for i, d in deltas.items():
        share = (d / total) if total != 0 else 0.0
        out.append((i, d, share))
    return sorted(out, key=lambda t: t[1])


# --------------------------------------------------------------------------- #
# 5. Platform-wide ("weather") test across consenting accounts
# --------------------------------------------------------------------------- #

def weather_log_bayes_factor(hits: int, n_accounts: int, base_rate: float = 0.03, alpha: float = 1.0, beta: float = 20.0) -> float:
    """log BF that the fraction of accounts with a changepoint in a shared +/-2-day window
    exceeds the background rate, using a Beta-Binomial alternative vs fixed base_rate null.
    Background ~3%/window is a placeholder to be calibrated from data.
    """
    if n_accounts == 0:
        return 0.0
    null = hits * log(base_rate) + (n_accounts - hits) * log(1 - base_rate)
    alt = _log_beta(alpha + hits, beta + n_accounts - hits) - _log_beta(alpha, beta)
    return alt - null


# --------------------------------------------------------------------------- #
# 6. Cause classifier (v1 rules with scores; v2 = calibrated model)
# --------------------------------------------------------------------------- #

@dataclass
class Signals:
    impressions: np.ndarray
    outbound_clicks: np.ndarray
    new_pins_impressions: np.ndarray | None = None   # impressions of Pins published in last 14d
    old_pins_impressions: np.ndarray | None = None
    linked_new_impr: float | None = None              # matched-pair means, if available
    unlinked_new_impr: float | None = None
    domain_block_error: bool = False
    visit_site_demoted: bool | None = None
    bulk_upload_or_ad_prefix: bool = False
    duplicate_url_rate_14d: float = 0.0
    peers_hit_fraction: float | None = None            # from weather index, if available
    yoy_same_window_ratio: float | None = None         # last year's drop ratio in same window, if imported
    ga4_pinterest_vs_direct_gap: float | None = None   # (direct_up - pinterest_down) normalised


@dataclass
class Diagnosis:
    onset_index: int | None
    drop: Drop | None
    rate_shift_log_bf: float | None
    scores: dict[str, float] = field(default_factory=dict)
    evidence: list[str] = field(default_factory=list)

    @property
    def ranked(self) -> list[tuple[str, float]]:
        return sorted(self.scores.items(), key=lambda t: -t[1])


def diagnose(s: Signals, min_drop: float = 0.3) -> Diagnosis:
    cps = pelt_mean_shift(s.impressions)
    if not cps:
        return Diagnosis(None, None, None, {"none": 1.0}, ["No changepoint detected"])
    # take the most recent changepoint that is a drop of at least min_drop
    drops = [quantify_drop(s.impressions, cp) for cp in cps]
    drops = [d for d in drops if d.ratio <= 1 - min_drop]
    if not drops:
        return Diagnosis(cps[-1], None, None, {"none": 1.0}, ["Changepoint found but not a material drop"])
    d = drops[-1]
    cp = d.onset_index
    w = 14
    k1, n1 = int(s.outbound_clicks[max(0, cp - w):cp].sum()), int(s.impressions[max(0, cp - w):cp].sum())
    k2, n2 = int(s.outbound_clicks[cp:cp + w].sum()), int(s.impressions[cp:cp + w].sum())
    lbf = rate_shift_log_bayes_factor(k1, n1, k2, n2)
    sc = {c: 0.0 for c in ("A_enforcement", "B_quality", "C_behavioural", "D_platform", "E_decay", "M_measurement")}
    ev: list[str] = [f"Impressions fell {100 * (1 - d.ratio):.0f}% at day {cp}"]

    if s.domain_block_error:
        sc["A_enforcement"] += 3.0; ev.append("Domain/link block error observed")
    if s.linked_new_impr is not None and s.unlinked_new_impr is not None and s.unlinked_new_impr > 0:
        r = (s.linked_new_impr + 1) / (s.unlinked_new_impr + 1)
        if r < 0.2:
            sc["A_enforcement"] += 2.0; sc["B_quality"] += 1.0; ev.append(f"Linked Pins at {r:.0%} of unlinked")
    if s.visit_site_demoted:
        sc["B_quality"] += 2.0; ev.append("Visit-site button demoted")
    if lbf <= 0:
        sc["D_platform"] += 1.5; sc["B_quality"] += 0.5; ev.append("Click rate unchanged: distribution cut, not content")
    else:
        sc["E_decay"] += 1.0; sc["C_behavioural"] += 0.5; ev.append("Click rate changed with the drop")
    if s.new_pins_impressions is not None and s.old_pins_impressions is not None:
        new_a = float(np.mean(s.new_pins_impressions[cp:cp + w])) if len(s.new_pins_impressions) > cp else 0.0
        old_b = float(np.mean(s.old_pins_impressions[max(0, cp - w):cp]))
        old_a = float(np.mean(s.old_pins_impressions[cp:cp + w]))
        if new_a < 2 and old_b > 0 and old_a / (old_b + 1e-9) > 0.6:
            sc["C_behavioural"] += 2.0; sc["A_enforcement"] += 1.0; ev.append("New Pins near zero, old Pins fine")
    if s.bulk_upload_or_ad_prefix:
        sc["C_behavioural"] += 1.0; ev.append("Bulk upload / '#ad' prefix pattern")
    if s.duplicate_url_rate_14d > 0.5:
        sc["C_behavioural"] += 1.5; ev.append(f"Duplicate URL rate {s.duplicate_url_rate_14d:.0%}")
    if s.peers_hit_fraction is not None:
        if s.peers_hit_fraction > 0.25:
            sc["D_platform"] += 3.0; ev.append(f"{s.peers_hit_fraction:.0%} of monitored accounts hit in the same window")
        else:
            sc["D_platform"] -= 1.0
    if s.yoy_same_window_ratio is not None and s.yoy_same_window_ratio <= 0.7:
        sc["E_decay"] += 2.0; ev.append("Same window fell last year too (seasonality)")
    if s.ga4_pinterest_vs_direct_gap is not None and s.ga4_pinterest_vs_direct_gap > 0.5:
        sc["M_measurement"] += 3.0; ev.append("GA4 Direct rose as Pinterest fell: likely iOS referral misattribution")

    # softmax to confidences
    vals = np.array(list(sc.values()))
    p = np.exp(vals - vals.max()); p /= p.sum()
    return Diagnosis(cp, d, lbf, {k: float(v) for k, v in zip(sc.keys(), p)}, ev)
