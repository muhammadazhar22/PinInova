"""PinPulse detection and diagnosis engine (v1). Specs: SPEC-011, SPEC-012, SPEC-013, SPEC-014.

Pure functions over ONE account's daily series. No I/O, no storage, no Pinterest calls.
The API (`api.py`) and the benchmark (`benchmark.py`) both call `diagnose(DiagnoseRequest)`.

Pipeline (docs/PLAN.md section 4):
  1. y = log1p(impressions); STL(period 7, robust) deseasonalisation when >= 28 complete points.
  2. PELT (ruptures, l2, min_size 7, penalty sigma^2 log T, sigma = 1.4826 MAD of first differences), cross-checked
     by PELT with the rank cost; `methods_agree` when both place a changepoint within +/-2 days.
  3. Confirmation: effect >= min_drop on raw medians, >= 5 complete (non-provisional, PA-08) post days, and the
     level has not recovered. One-sided Mann-Whitney p-value on deseasonalised log values for BH across accounts.
  4. Online one-sided CUSUM on log1p (k = log(2)/2, causal baseline) gives `warning` before confirmation is
     possible; it may use provisional days.
  5. Rate stability (Beta-Binomial log BF + posterior ratio, overdispersion-corrected), step-vs-fade shape,
     breadth (age buckets, domains, linked vs unlinked), per-Pin decomposition and concentration.
  6. Rule scores -> softmax over cause classes; every score contribution emits an evidence item.

No lookahead: every quantity dated t uses data <= t only (CUSUM is strictly causal; offline steps use the series
as received, which ends "today").
"""
from __future__ import annotations

from dataclasses import dataclass, field
from math import lgamma, log, sqrt
from typing import Literal

import numpy as np
import ruptures as rpt
from ruptures.base import BaseCost
from scipy.stats import mannwhitneyu, rankdata
from statsmodels.tsa.seasonal import STL

from .schemas import (
    AGE_KEYS,
    CAUSES,
    AgeBreadth,
    BreadthOut,
    CauseClass,
    ClassProb,
    ConcentrationOut,
    DiagnoseRequest,
    DiagnoseResponse,
    DiagnoseSignals,
    DomainBreadth,
    DropOut,
    Evidence,
    PinContribution,
    RateOut,
)

DETECTOR_VERSION = "2.0.0"

MIN_SIZE = 7
MIN_POST_DAYS = 5
WINDOW = 14
RATE_MIN_POST_IMPRESSIONS = 500
CUSUM_K = log(2) / 2
# h = CUSUM_H_MULT * sigma_t (per-day log-scale noise from a trailing robust estimate). Tuned with
# `python -m pinpulse_analytics.benchmark --tune-cusum` to ~1 false alarm per account-year on the no-cliff
# accounts of seeds 7/11/23 (see docs/detector-log.md).
CUSUM_H_MULT = 5.25
CUSUM_BASELINE = 28
RANK_PEN_PER_LOG_T = 1.0   # BIC for a chi^2_1-scaled rank statistic
PRIOR_ALPHA = 2.0          # Beta prior strength for rate tests (mean = pooled rate)
RATE_POST_DAYS = 28
FADE_GAIN = 3.0            # fade if SSE(step) - SSE(ramp, L >= 4) > FADE_GAIN * sigma^2 log N


# --------------------------------------------------------------------------- #
# 1. Preprocessing
# --------------------------------------------------------------------------- #

def deseasonalise(y: np.ndarray) -> np.ndarray:
    """Remove weekly seasonality with robust STL when there are >= 28 points (else return y)."""
    if len(y) < 28 or np.ptp(y) == 0:
        return y.copy()
    res = STL(y, period=7, robust=True).fit()
    z = np.asarray(y - res.seasonal, dtype=float)
    # Guard: robust STL can break down on near-noiseless series with a step (bisquare weights collapse and the
    # seasonal term absorbs the step). Keep the adjustment only if it makes the series smoother day to day.
    if mad_sigma_of_diffs(z) > mad_sigma_of_diffs(y):
        return y.copy()
    return z


def mad_sigma_of_diffs(z: np.ndarray) -> float:
    """sigma-hat = 1.4826 * MAD of first differences (robust to the level shift itself)."""
    d = np.diff(z)
    if len(d) == 0:
        return 0.0
    return float(1.4826 * np.median(np.abs(d - np.median(d))))


# --------------------------------------------------------------------------- #
# 2. Changepoints (ruptures PELT, l2 and rank costs)
# --------------------------------------------------------------------------- #

class _CostL2Fast(BaseCost):
    """ruptures l2 cost with O(1) segment cost from cumulative sums (identical values to model='l2')."""
    model = "l2_fast"
    min_size = 2

    def fit(self, signal: np.ndarray) -> _CostL2Fast:
        s = np.asarray(signal, dtype=float).reshape(-1)
        self.signal = s.reshape(-1, 1)
        self.cs = np.concatenate([[0.0], np.cumsum(s)])
        self.cs2 = np.concatenate([[0.0], np.cumsum(s * s)])
        return self

    def error(self, start: int, end: int) -> float:
        m = end - start
        s = self.cs[end] - self.cs[start]
        return float(self.cs2[end] - self.cs2[start] - s * s / m)


class _CostRankFast(BaseCost):
    """ruptures rank cost (Lung-Yut-Fong et al. 2015) for 1-D signals with cumulative sums."""
    model = "rank_fast"
    min_size = 2

    def fit(self, signal: np.ndarray) -> _CostRankFast:
        s = np.asarray(signal, dtype=float).reshape(-1)
        self.signal = s.reshape(-1, 1)
        r = rankdata(s) - (len(s) + 1) / 2
        var = float(np.mean(r * r))
        self.inv = 1.0 / var if var > 0 else 0.0
        self.cs = np.concatenate([[0.0], np.cumsum(r)])
        return self

    def error(self, start: int, end: int) -> float:
        m = end - start
        mean = (self.cs[end] - self.cs[start]) / m
        return float(-m * mean * mean * self.inv)


def _pelt(z: np.ndarray, cost: BaseCost, pen: float, min_size: int = MIN_SIZE) -> list[int]:
    if len(z) < 2 * min_size:
        return []
    algo = rpt.Pelt(custom_cost=cost, min_size=min_size, jump=1).fit(z)
    return [int(b) for b in algo.predict(pen=pen)[:-1]]


def pelt_l2(z: np.ndarray, min_size: int = MIN_SIZE) -> tuple[list[int], float]:
    """PELT l2 on the (deseasonalised) log series with beta = sigma-hat^2 log T. Returns (cps, sigma-hat)."""
    sig = max(mad_sigma_of_diffs(z), 0.02)
    return _pelt(z, _CostL2Fast(), sig * sig * log(len(z)), min_size), sig


def pelt_rank(z: np.ndarray, min_size: int = MIN_SIZE) -> list[int]:
    return _pelt(z, _CostRankFast(), RANK_PEN_PER_LOG_T * log(len(z)), min_size)


def refine_changepoints(z: np.ndarray, cps: list[int], n: int, reach: int = 6, min_side: int = 3) -> list[int]:
    """Re-locate each changepoint by the best single l2 split between its neighbours (within +/-reach days,
    >= min_side points each side). PELT's min_size forces a changepoint close to the end of the series to sit
    early (the last segment must be >= 7 days); the local search removes that boundary bias."""
    out: list[int] = []
    bounds = [0] + list(cps) + [n]
    for j, cp in enumerate(cps, start=1):
        lo, hi = bounds[j - 1], bounds[j + 1]
        best, arg = np.inf, cp
        seg = z[lo:hi]
        cs, cs2 = np.concatenate([[0.0], np.cumsum(seg)]), np.concatenate([[0.0], np.cumsum(seg * seg)])
        m = hi - lo
        for c in range(max(lo + min_side, cp - reach), min(hi - min_side, cp + reach) + 1):
            k = c - lo
            left = cs2[k] - cs[k] ** 2 / k
            right = (cs2[m] - cs2[k]) - (cs[m] - cs[k]) ** 2 / (m - k)
            if left + right < best:
                best, arg = left + right, c
        out.append(int(arg))
    return sorted(set(out))


def pelt_mean_shift(x: np.ndarray, min_size: int = MIN_SIZE) -> list[int]:
    """Convenience: changepoints of a raw count series (log1p, STL, PELT l2)."""
    return pelt_l2(deseasonalise(np.log1p(np.asarray(x, dtype=float))), min_size)[0]


# --------------------------------------------------------------------------- #
# 3. Online CUSUM (early warning)
# --------------------------------------------------------------------------- #

@dataclass
class CusumResult:
    alarms: list[int]          # alarm days (S_t > h_t), resetting after each alarm
    starts: list[int]          # estimated start of the run that produced each alarm
    stat: np.ndarray           # S_t (without resets after the first alarm of a run)
    active_at_end: bool        # the most recent alarm's run has not returned to zero


def cusum_drop(x: np.ndarray, k: float = CUSUM_K, h_mult: float = CUSUM_H_MULT,
               baseline: int = CUSUM_BASELINE) -> CusumResult:
    """One-sided lower CUSUM on log1p(x), strictly causal.

    Expected value at t: median of the trailing `baseline` days plus half the same-weekday deviation of the
    trailing four weeks. Deficit d_t = expected_t - y_t; S_t = max(0, S_{t-1} + d_t - k); alarm when
    S_t > h_mult * sigma_t, sigma_t = 1.4826 MAD(first differences of the trailing window) / sqrt(2).
    Only data <= t is used for day t.
    """
    y = np.log1p(np.asarray(x, dtype=float))
    n = len(y)
    warm = min(baseline, max(7, n // 2))
    s = 0.0
    run_start = None
    stat = np.zeros(n)
    alarms: list[int] = []
    starts: list[int] = []
    in_alarm = False
    for t in range(warm, n):
        hist = y[max(0, t - baseline):t]
        med = float(np.median(hist))
        same = hist[::-1][6::7]  # t-7, t-14, ...
        exp_t = med + 0.5 * (float(np.median(same)) - med) if len(same) >= 2 else med
        sig = max(mad_sigma_of_diffs(hist) / sqrt(2), 0.05)
        d = exp_t - y[t]
        new = max(0.0, s + d - k)
        if s == 0.0 and new > 0:
            run_start = t
        s = new
        if s == 0.0:
            run_start = None
            in_alarm = False
        stat[t] = s
        if s > h_mult * sig and not in_alarm:
            alarms.append(t)
            starts.append(run_start if run_start is not None else t)
            in_alarm = True   # one alarm per run; the run must return to zero before another alarm
    return CusumResult(alarms, starts, stat, bool(in_alarm))


def early_warning(x: np.ndarray, provisional_days: int, cus: CusumResult | None = None) -> tuple[int, int] | None:
    """(alarm_index, run_start) when an online CUSUM alarm is active today for a drop that cannot be confirmed
    yet: fewer than MIN_POST_DAYS (+2 grace) complete days since the run began, and at least one complete day in
    the run, so the reporting lag on the provisional tail (PA-08) cannot raise a warning by itself."""
    cus = cus if cus is not None else cusum_drop(x)
    if not (cus.active_at_end and cus.alarms):
        return None
    n_conf = len(x) - provisional_days
    start = cus.starts[-1]
    if start <= n_conf - 1 and n_conf - start < MIN_POST_DAYS + 2:
        return cus.alarms[-1], start
    return None


# --------------------------------------------------------------------------- #
# 4. Rates (Beta-Binomial)
# --------------------------------------------------------------------------- #

def _log_beta(a: float, b: float) -> float:
    return lgamma(a) + lgamma(b) - lgamma(a + b)


def rate_shift_log_bayes_factor(k1: float, n1: float, k2: float, n2: float,
                                alpha: float = 1.0, beta: float = 1.0) -> float:
    """log BF of 'two different rates' vs 'one shared rate' for k successes in n trials (Beta prior)."""
    if n1 <= 0 or n2 <= 0:
        return 0.0
    k1, k2 = min(k1, n1), min(k2, n2)
    same = _log_beta(alpha + k1 + k2, beta + (n1 - k1) + (n2 - k2)) - _log_beta(alpha, beta)
    diff = (_log_beta(alpha + k1, beta + n1 - k1) - _log_beta(alpha, beta)) + (
        _log_beta(alpha + k2, beta + n2 - k2) - _log_beta(alpha, beta))
    return diff - same


@dataclass
class RateTest:
    verdict: Literal["stable", "changed", "insufficient"]
    direction: str            # fell | rose | flat | ""
    log_bf: float | None
    before: float | None
    after: float | None
    post_n: int
    p_lower: float | None = None   # P(after/before < 0.8)
    dispersion: float = 1.0


def rate_test(k: np.ndarray, n: np.ndarray, pre: slice, post: slice, min_post: int = RATE_MIN_POST_IMPRESSIONS,
              seed: int = 0) -> RateTest:
    """Compare k/n before vs after. Daily over-dispersion (Pearson chi^2 over pre days) deflates the counts so a
    pooled binomial does not overstate evidence (design effect; Ibrahim & Girmay 2026)."""
    kb, nb = np.minimum(k[pre], n[pre]), n[pre]
    ka, na = np.minimum(k[post], n[post]), n[post]
    post_n = int(round(float(na.sum())))
    k1, n1, k2, n2 = float(kb.sum()), float(nb.sum()), float(ka.sum()), float(na.sum())
    r1 = k1 / n1 if n1 > 0 else None
    r2 = k2 / n2 if n2 > 0 else None
    if post_n < min_post or n1 <= 0:
        return RateTest("insufficient", "", None, r1, r2, post_n)
    ok = nb > 0
    phi = 1.0
    if ok.sum() >= 5 and r1 and 0 < r1 < 1:
        chi2 = float(np.sum((kb[ok] - nb[ok] * r1) ** 2 / (nb[ok] * r1 * (1 - r1))))
        phi = max(1.0, chi2 / (ok.sum() - 1))
    # Empirical-Bayes Beta prior centred on the pooled rate (prior "sample size" alpha0 / r_hat). A uniform prior
    # would penalise the two-rate model heavily at CTRs of 1-3% (Lindley's paradox) and hide real rate changes.
    r_hat = min(max((k1 + k2) / (n1 + n2), 1e-6), 1 - 1e-6)
    a0 = PRIOR_ALPHA
    b0 = a0 * (1 - r_hat) / r_hat
    lbf = rate_shift_log_bayes_factor(k1 / phi, n1 / phi, k2 / phi, n2 / phi, a0, b0)
    rng = np.random.default_rng(seed)
    a = rng.beta(a0 + k1 / phi, b0 + (n1 - k1) / phi, 4000)
    b = rng.beta(a0 + k2 / phi, b0 + (n2 - k2) / phi, 4000)
    rho = b / a
    p_lower, p_upper = float(np.mean(rho < 0.8)), float(np.mean(rho > 1.25))
    if lbf > 1.0 and p_lower > 0.8:
        return RateTest("changed", "fell", lbf, r1, r2, post_n, p_lower, phi)
    if lbf > 1.0 and p_upper > 0.8:
        return RateTest("changed", "rose", lbf, r1, r2, post_n, p_lower, phi)
    return RateTest("stable", "flat", lbf, r1, r2, post_n, p_lower, phi)


# --------------------------------------------------------------------------- #
# 5. Shape, breadth, decomposition
# --------------------------------------------------------------------------- #

@dataclass
class ShapeFit:
    shape: str              # step | fade | unknown
    start: int | None       # start of the decline (refined onset for fades)
    length: int | None      # ramp length of the best fade model
    gain: float = 0.0       # SSE(step) - SSE(fade), in units of sigma^2 log N
    ramp_start: int | None = None   # start of the best ramp with L >= 2 (used to date a fade)


def fit_shape(z: np.ndarray, cp: int, n_conf: int, sigma_day: float) -> ShapeFit:
    """Step vs smooth fade. Grid-search a ramp model (level a, linear decline over L days from s, level b) on
    the log series around the changepoint; L = 1 is a step. 'fade' when the best L >= 4 beats the best step by
    more than 2 sigma^2 log N (BIC-like), 'step' when the best model overall has L <= 2."""
    lo, hi = max(0, cp - 21), min(n_conf, cp + 14)
    if hi - cp < 7 or cp - lo < 7:
        return ShapeFit("unknown", None, None)
    seg = z[lo:hi]
    tt = np.arange(lo, hi)
    best: dict[int, tuple[float, int, float]] = {}
    for L in range(1, 13):
        for s in range(max(lo + 3, cp - 12), min(cp + 3, hi - L - 2) + 1):
            frac = np.clip((tt - s) / L, 0, 1)
            # least squares for a, b with y = a (1 - frac) + b frac
            X = np.column_stack([1 - frac, frac])
            coef, *_ = np.linalg.lstsq(X, seg, rcond=None)
            if coef[1] >= coef[0]:
                continue
            sse = float(np.sum((seg - X @ coef) ** 2))
            if L not in best or sse < best[L][0]:
                best[L] = (sse, s, float(coef[0] - coef[1]))
    if not best:
        return ShapeFit("unknown", None, None)
    step_sse, step_s, _ = min((best[L] for L in (1, 2) if L in best), default=(np.inf, cp, 0.0))
    ramps = [(best[L][0], L, best[L][1]) for L in best if L >= 2]
    ramp_start = min(ramps)[2] if ramps else None
    fades = [(best[L][0], L, best[L][1], best[L][2]) for L in best if L >= 4]
    if not fades:
        return ShapeFit("step", step_s, 1, 0.0, ramp_start)
    f_sse, f_L, f_s, f_delta = min(fades)
    unit = max(sigma_day, 0.05) ** 2 * log(len(seg))
    gain = float(step_sse - f_sse) / unit
    # a real ramp of length L costs a step model about delta^2 L / 24 once the step levels refit; require half
    # of that so tiny
    # deseasonalisation artefacts on very smooth (large-account) series cannot pass as a fade
    if gain > FADE_GAIN and (step_sse - f_sse) >= f_delta * f_delta * f_L / 48:
        return ShapeFit("fade", f_s, f_L, gain, ramp_start)
    overall = min(best.items(), key=lambda kv: kv[1][0])
    if overall[0] <= 2 or gain <= 0:
        return ShapeFit("step", step_s, 1, gain, ramp_start)
    return ShapeFit("unknown", None, None, gain, ramp_start)


@dataclass
class Spike:
    rise_index: int
    rise: float            # level multiple at the rise
    returned: float        # post-drop level / pre-rise level


def find_spike(z: np.ndarray, cps: list[int], cp: int, n_conf: int) -> Spike | None:
    """A rise of >= 60% within 28 days before the drop, after which the level returned to within 40% of the
    pre-rise level: the signature of a viral Pin (or seasonal peak) fading rather than a cut."""
    bounds = [0] + cps + [n_conf]
    post = z[cp:min(cp + WINDOW, n_conf)]
    if len(post) < MIN_POST_DAYS:
        return None
    for j in range(len(cps) - 1, -1, -1):
        r = cps[j]
        if r >= cp - 4:
            continue
        if r < cp - 28:
            break
        before = z[max(bounds[j], r - WINDOW):r]
        after = z[r:min(bounds[j + 2], cp)]
        if len(before) < 5 or len(after) < 3:
            continue
        rise = float(np.mean(after) - np.mean(before))
        if rise < log(1.6):
            continue
        ret = float(np.mean(post) - np.mean(before))
        if abs(ret) <= log(1.4):
            return Spike(r, float(np.exp(rise)), float(np.exp(ret)))
    return None


def _ratio(series: np.ndarray, pre: slice, post: slice) -> float | None:
    b = float(np.mean(series[pre])) if series[pre].size else 0.0
    a = float(np.mean(series[post])) if series[post].size else 0.0
    return None if b <= 0 else a / b


def pin_contributions(pin_before: dict[str, float], pin_after: dict[str, float]) -> list[tuple[str, float, float]]:
    """Exact additive decomposition of an account change: [(pin_id, delta, share_of_total_change)], biggest
    losses first. For an additive metric the Shapley value of a Pin is its own delta."""
    ids = set(pin_before) | set(pin_after)
    deltas = {i: pin_after.get(i, 0.0) - pin_before.get(i, 0.0) for i in ids}
    total = sum(deltas.values())
    out = [(i, d, (d / total) if total != 0 else 0.0) for i, d in deltas.items()]
    return sorted(out, key=lambda r: (r[1], r[0]))


def gini(x: np.ndarray) -> float | None:
    x = np.sort(np.asarray(x, dtype=float))
    if len(x) == 0 or x.sum() <= 0:
        return None
    n = len(x)
    cum = np.cumsum(x)
    return float((n + 1 - 2 * np.sum(cum) / cum[-1]) / n)


def quantify_drop(x: np.ndarray, cp: int, window: int = WINDOW, end: int | None = None,
                  start: int = 0) -> tuple[float, float, float]:
    """(before_median, after_median, ratio) of raw values around cp. ratio = after/before (1.0 if before == 0)."""
    x = np.asarray(x, dtype=float)
    end = len(x) if end is None else end
    before = x[max(start, cp - window):cp]
    after = x[cp:min(cp + window, end)]
    b = float(np.median(before)) if len(before) else 0.0
    a = float(np.median(after)) if len(after) else 0.0
    return b, a, (a / b if b > 0 else 1.0)


# --------------------------------------------------------------------------- #
# 6. Classifier: rule scores -> softmax, one evidence item per contribution
# --------------------------------------------------------------------------- #

@dataclass
class _Scorer:
    scores: dict[str, float] = field(default_factory=lambda: {c: 0.0 for c in CAUSES})
    evidence: list[Evidence] = field(default_factory=list)

    def add(self, code: str, text: str, weights: dict[str, float]) -> None:
        for c, w in weights.items():
            self.scores[c] += w
        supports: list[CauseClass] = [c for c in CAUSES if weights.get(c, 0.0) > 0]
        self.evidence.append(Evidence(code=code, text=text, supports=supports))

    def note(self, code: str, text: str) -> None:
        self.evidence.append(Evidence(code=code, text=text, supports=[]))


# Prior log-odds: v1 rules have no data on M without GA4, so M starts low; D is the commonest reported cause.
PRIOR = {"A_enforcement": 0.0, "B_quality": 0.0, "C_behavioural": 0.0, "D_platform": 0.3, "E_decay": -0.3,
         "M_measurement": -2.0}


def _pct(x: float) -> str:
    return f"{100 * x:.0f}%"


@dataclass
class Features:
    rate: RateTest
    shape: ShapeFit
    age: dict[str, float | None] | None
    age_share: dict[str, float] | None
    domains: list[DomainBreadth] | None
    linked_ratio: float | None
    unlinked_ratio: float | None
    unlinked_share: float | None
    top_pin_share: float | None
    top1_share: float | None
    n_pins: int
    save_rate: RateTest | None
    signals: DiagnoseSignals
    spike: Spike | None = None


def classify(f: Features) -> _Scorer:  # noqa: C901 - a flat list of explainable rules
    sc = _Scorer()
    for c, w in PRIOR.items():
        sc.scores[c] += w

    # rates: distribution cut (A/C/D) vs content-quality down-ranking (B)
    r = f.rate
    if r.verdict == "stable":
        sc.add("rate_stable", f"Outbound click rate held ({_pct(r.before or 0)} → {_pct(r.after or 0)} of impressions, "
               f"log BF {r.log_bf:.1f}): distribution was cut upstream, the content still converts.",
               {"D_platform": 1.0, "A_enforcement": 0.75, "C_behavioural": 0.5})
    elif r.verdict == "changed" and r.direction == "fell":
        sc.add("rate_fell", f"Outbound click rate fell with the drop ({100 * (r.before or 0):.2f}% → "
               f"{100 * (r.after or 0):.2f}%, log BF {r.log_bf:.1f}): consistent with quality down-ranking.",
               {"B_quality": 2.5, "E_decay": 0.3})
    elif r.verdict == "changed":
        sc.add("rate_rose", f"Outbound click rate rose after the drop ({100 * (r.before or 0):.2f}% → "
               f"{100 * (r.after or 0):.2f}%): the remaining audience is more engaged, so reach was cut upstream.",
               {"D_platform": 0.5, "A_enforcement": 0.5, "C_behavioural": 0.5})
    else:
        sc.note("rate_insufficient", f"Only {r.post_n} post-drop impressions so far; the click-rate verdict needs "
                f"at least {RATE_MIN_POST_IMPRESSIONS}.")
    if f.save_rate is not None and f.save_rate.verdict == "changed" and f.save_rate.direction == "fell":
        sc.add("save_rate_fell", f"Saves per impression fell too ({100 * (f.save_rate.before or 0):.2f}% → "
               f"{100 * (f.save_rate.after or 0):.2f}%).", {"B_quality": 1.0})

    # shape
    if f.shape.shape == "fade":
        sc.add("shape_fade", f"A smooth decline over about {f.shape.length} days rather than a step: the pattern "
               "of a viral Pin fading.", {"E_decay": 2.5})
    elif f.shape.shape == "step":
        sc.add("shape_step", "A step change within 1-2 days: something switched, not a gradual fade.",
               {"A_enforcement": 0.4, "C_behavioural": 0.3, "D_platform": 0.5, "B_quality": 0.2, "E_decay": -1.0})

    if f.spike is not None:
        sc.add("spike_returned", f"Impressions had risen to {f.spike.rise:.1f}x around day {f.spike.rise_index} and "
               f"are now back to {_pct(f.spike.returned)} of the level before that rise: a spike fading, not a cut.",
               {"E_decay": 2.5, "A_enforcement": -0.5, "D_platform": -0.5, "C_behavioural": -0.5})

    # age strata (Pin age at the date)
    one_pin = f.top_pin_share is not None and f.top_pin_share >= 0.5
    if f.age and f.age_share and one_pin:
        sc.note("age_skipped_one_pin", "Age strata are not used: one Pin dominates the loss and moves between age "
                "buckets as it ages.")
    elif f.age and f.age_share:
        vol = {k: v for k, v in f.age.items() if v is not None and f.age_share.get(k, 0) >= 0.03}
        new = vol.get("0-7") if f.age_share.get("0-7", 0) >= 0.05 else None
        old_keys = [k for k in ("30+", "15-29") if k in vol]
        old = vol[old_keys[0]] if old_keys else None
        if new is not None and old is not None:
            if new <= 0.3 and old >= 3.0 * max(new, 1e-3):
                sc.add("age_new_collapsed", f"New Pins (0-7 days) fell to {_pct(new)} of their earlier level while "
                       f"older Pins kept {_pct(old)}: fresh distribution was cut, the behavioural-signal pattern.",
                       {"C_behavioural": 3.0, "A_enforcement": -0.5, "D_platform": -0.5})
            elif old <= 0.35 and new >= 0.6:
                sc.add("age_mature_collapsed", f"Pins older than a week fell to {_pct(old)} while new Pins held at "
                       f"{_pct(new)}: a retrieval-side cut on mature Pins, as in the Aug 2026 platform event.",
                       {"D_platform": 3.0, "A_enforcement": -0.5, "C_behavioural": -1.0})
            elif (len(vol) >= 3 and max(vol.values()) <= 0.65
                  and max(vol.values()) <= 2.0 * max(min(vol.values()), 1e-3)):
                sc.add("age_uniform", "Pins of every age fell by a similar fraction ("
                       + ", ".join(f"{k}: {_pct(v)}" for k, v in vol.items()) + ").",
                       {"D_platform": 0.6, "B_quality": 0.5, "A_enforcement": 0.4, "C_behavioural": -1.0})

    # destination domains (Pinterest enforces per domain)
    confined = False
    if f.domains:
        big = [d for d in f.domains if d.share_before >= 0.15 and d.ratio is not None]
        for d in sorted(big, key=lambda d: -d.share_before):
            others = [o for o in f.domains if o.domain != d.domain and o.ratio is not None and o.share_before >= 0.03]
            rest: list[tuple[float, float]] = [(o.ratio, o.share_before) for o in others if o.ratio is not None]
            if f.unlinked_ratio is not None and (f.unlinked_share or 0) >= 0.03:
                rest.append((f.unlinked_ratio, f.unlinked_share or 0.0))
            if not rest or d.ratio is None:
                continue
            rest_ratio = sum(rv * s for rv, s in rest) / sum(s for _, s in rest)
            if d.ratio <= 0.3 and rest_ratio >= 0.6:
                confined = True
                sc.add("domain_confined", f"Pins linking to {d.domain} ({_pct(d.share_before)} of reach) fell to "
                       f"{_pct(d.ratio)} while other destinations held at {_pct(rest_ratio)}: Pinterest applies "
                       "enforcement to all Pins linking to the same domain.",
                       {"A_enforcement": 3.0, "E_decay": 0.5, "D_platform": -1.0, "B_quality": -0.5,
                        "C_behavioural": -0.5})
                break
        if not confined:
            vals = [d.ratio for d in f.domains if d.ratio is not None and d.share_before >= 0.05]
            if f.unlinked_ratio is not None and (f.unlinked_share or 0) >= 0.03:
                vals.append(f.unlinked_ratio)
            if len(vals) >= 2 and max(vals) <= 0.6:
                sc.add("domains_all_dropped", "Every destination fell together, including Pins without a link "
                       f"(highest remaining: {_pct(max(vals))}): not a single-domain enforcement.",
                       {"D_platform": 1.0, "B_quality": 0.5, "C_behavioural": 0.3, "A_enforcement": -1.5})

    # matched-pair experiment from the user (linked vs unlinked new Pins)
    s = f.signals
    if s.linked_new_impr is not None and s.unlinked_new_impr is not None and s.unlinked_new_impr > 0:
        rr = (s.linked_new_impr + 1) / (s.unlinked_new_impr + 1)
        if rr < 0.2:
            sc.add("matched_pair_linked_low", f"In your matched test, new linked Pins got {_pct(rr)} of the "
                   "impressions of unlinked ones.", {"A_enforcement": 2.0, "B_quality": 1.0})

    # Pin decomposition
    if f.top_pin_share is not None:
        if f.top_pin_share >= 0.5:
            sc.add("single_pin_drop", f"One Pin explains {_pct(f.top_pin_share)} of the lost impressions.",
                   {"E_decay": 3.0, "A_enforcement": -0.5, "D_platform": -0.5, "C_behavioural": -0.5})
        elif f.top_pin_share < 0.2 and f.n_pins >= 10:
            sc.add("broad_pin_drop", f"The loss is spread across many Pins (largest single Pin: "
                   f"{_pct(f.top_pin_share)}).", {"E_decay": -1.5})
    if f.top1_share is not None and f.top1_share > 0.5:
        sc.add("top_heavy", f"Before the drop the top 1% of Pins carried {_pct(f.top1_share)} of impressions.",
               {"E_decay": 0.5})

    # side signals
    if s.domain_block_error:
        sc.add("domain_block_error", "A link/domain block error was reported for this account.", {"A_enforcement": 3.0})
    if s.visit_site_demoted:
        sc.add("visit_site_demoted", "The Visit-site button was demoted.", {"B_quality": 2.0})
    if s.bulk_upload_or_ad_prefix:
        sc.add("bulk_or_ad_prefix", "Bulk upload or '#ad'-prefix pattern before the drop.", {"C_behavioural": 1.0})
    if s.duplicate_url_rate_14d > 0.5:
        sc.add("duplicate_urls", f"{_pct(s.duplicate_url_rate_14d)} of Pins in the prior 14 days repeated a URL.",
               {"C_behavioural": 1.5})
    if s.peers_hit_fraction is not None:
        if s.peers_hit_fraction > 0.25:
            sc.add("peers_hit", f"{_pct(s.peers_hit_fraction)} of reporting accounts dropped in the same window.",
                   {"D_platform": 3.0})
        else:
            sc.add("peers_quiet", f"Only {_pct(s.peers_hit_fraction)} of reporting accounts dropped in the same "
                   "window.", {"D_platform": -1.0})
    if s.yoy_same_window_ratio is not None and s.yoy_same_window_ratio <= 0.7:
        sc.add("seasonal_yoy", f"The same window fell to {_pct(s.yoy_same_window_ratio)} last year too "
               "(seasonality).", {"E_decay": 2.0})
    if s.ga4_pinterest_vs_direct_gap is not None and s.ga4_pinterest_vs_direct_gap > 0.5:
        sc.add("ga4_direct_rose", "GA4 Direct sessions rose as Pinterest referrals fell: likely referral "
               "misattribution, not a real reach change.", {"M_measurement": 3.0})
    return sc


def softmax(scores: dict[str, float]) -> list[tuple[str, float]]:
    keys = list(scores)
    v = np.array([scores[k] for k in keys])
    p = np.exp(v - v.max())
    p /= p.sum()
    return sorted(zip(keys, p.tolist()), key=lambda kv: -kv[1])


# --------------------------------------------------------------------------- #
# 7. Orchestration
# --------------------------------------------------------------------------- #

def _date(req: DiagnoseRequest, i: int | None) -> str | None:
    if i is None:
        return None
    if req.dates is not None:
        return req.dates[i].isoformat()
    return None


def _empty_breadth() -> BreadthOut:
    return BreadthOut(age=None, domains=None, linked_ratio=None, unlinked_ratio=None)


@dataclass
class _Onset:
    cp: int
    before: float
    after: float
    ratio: float


def _confirm(x: np.ndarray, z: np.ndarray, cps: list[int], n_conf: int, min_drop: float) -> _Onset | None:
    """Drop event among changepoints: effect >= min_drop, >= MIN_POST_DAYS complete post days and not recovered
    (median of the last 7 complete days still <= (1 - min_drop/2) of the pre level)."""
    cps = refine_changepoints(z, cps, n_conf)
    qual: list[_Onset] = []
    for j, cp in enumerate(cps):
        if n_conf - cp < MIN_POST_DAYS:
            continue
        prev = cps[j - 1] if j > 0 else 0
        b, a, ratio = quantify_drop(x, cp, WINDOW, n_conf, start=prev)
        if b <= 0 or 1 - ratio < min_drop:
            continue
        tail = x[max(cp, n_conf - 7):n_conf]
        if float(np.median(tail)) > (1 - min_drop / 2) * b:
            continue
        qual.append(_Onset(cp, b, a, ratio))
    if not qual:
        return None
    # group qualifying changepoints into events (within WINDOW days of each other, dated at the first one) and
    # report the event that fell from the highest level: the drop from the account's healthy level.
    # Within an event, keep the changepoint with the largest fall between adjacent PELT segment means (a spurious
    # changepoint a few days early also "qualifies" because its after-window spans the real cliff).
    bounds = [0] + cps + [n_conf]
    seg_fall = {}
    for j, cp in enumerate(cps, start=1):
        seg_fall[cp] = float(np.mean(z[bounds[j - 1]:cp]) - np.mean(z[cp:bounds[j + 1]]))
    groups: list[list[_Onset]] = []
    for q in qual:
        if groups and q.cp - groups[-1][0].cp <= WINDOW:
            groups[-1].append(q)
        else:
            groups.append([q])
    events = [max(g, key=lambda e: seg_fall.get(e.cp, 0.0)) for g in groups]
    return max(events, key=lambda e: (e.before, e.cp))


def diagnose(req: DiagnoseRequest) -> DiagnoseResponse:  # noqa: C901
    x = np.asarray(req.impressions, dtype=float)
    n = len(x)
    P = req.provisional_days
    n_conf = n - P
    sig_in = req.signals or DiagnoseSignals()
    y_conf = np.log1p(x[:n_conf])
    z = deseasonalise(y_conf)
    cps_l2, sigma_hat = pelt_l2(z)
    sigma_day = sigma_hat / sqrt(2)
    cus = cusum_drop(x)

    ev = _Scorer()
    onset = _confirm(x, z, cps_l2, n_conf, req.min_drop)

    # ---------- no confirmed drop: maybe an early warning ----------
    if onset is None:
        status: Literal["none", "warning", "drop"] = "none"
        w_idx = None
        warn = early_warning(x, P)
        if warn is not None:
            status = "warning"
            w_idx, start = warn
            recent = x[start:]
            base = float(np.median(x[max(0, start - CUSUM_BASELINE):start])) if start > 0 else 0.0
            lvl = (float(np.median(recent)) / base) if base > 0 else 1.0
            ev.note("early_warning", f"Impressions have run at about {_pct(lvl)} of the trailing 28-day level for "
                    f"{n - start} day(s) since {_date(req, start) or f'day {start}'}; this includes up to {P} "
                    "provisional day(s) and is not yet confirmable (needs 5 complete days).")
        if status == "none":
            ev.note("no_drop", "No material drop: no changepoint with a sustained fall of at least "
                    f"{_pct(req.min_drop)} on complete days." if not cps_l2 else
                    f"Level changes were found ({len(cps_l2)}) but none is a sustained fall of at least "
                    f"{_pct(req.min_drop)}.")
        return DiagnoseResponse(
            status=status, onset_index=None, onset_date=None, warning_index=w_idx, warning_date=_date(req, w_idx),
            drop=None, methods_agree=False, p_value=None,
            rate=RateOut(verdict="insufficient", log_bf=None, ctr_before=None, ctr_after=None, post_impressions=0),
            breadth=_empty_breadth(), pin_contributions=[], concentration=ConcentrationOut(), shape="unknown",
            classes=[], evidence=ev.evidence, confidence="low", detector_version=DETECTOR_VERSION)

    # ---------- confirmed drop ----------
    cp = onset.cp
    cps_rank = pelt_rank(z)
    agree = any(abs(c - cp) <= 2 for c in cps_rank)
    shp = fit_shape(z, cp, n_conf, sigma_day)
    spike = find_spike(z, cps_l2, cp, n_conf)
    t0 = cp
    if shp.shape == "fade" and shp.start is not None:
        t0 = int(shp.start)
    elif spike is not None and shp.ramp_start is not None and shp.ramp_start < cp:
        t0 = int(shp.ramp_start)   # date a fading spike at the start of its decline
    prev = max([c for c in cps_l2 if c < cp], default=0)
    b0 = max(prev if prev < t0 else 0, t0 - WINDOW)
    pre = slice(b0, t0)
    post = slice(t0, min(t0 + WINDOW, n_conf))
    b_med, a_med, ratio = quantify_drop(x, t0, WINDOW, n_conf, start=b0)
    if b_med <= 0:
        b_med, a_med, ratio = onset.before, onset.after, onset.ratio
    zb, za = z[pre], z[post]
    p_value = float(mannwhitneyu(zb, za, alternative="greater").pvalue) if len(zb) >= 3 and len(za) >= 3 else None

    clicks = np.asarray(req.outbound_clicks, dtype=float)
    rate_pre = slice(max(0, t0 - 28), t0)
    rate_post = slice(t0, min(t0 + RATE_POST_DAYS, n_conf))
    rate = rate_test(clicks, x, rate_pre, rate_post)
    save_rate = (rate_test(np.asarray(req.saves, dtype=float), x, rate_pre, rate_post)
                 if req.saves is not None else None)

    # breadth
    age_ratio: dict[str, float | None] | None = None
    age_share: dict[str, float] | None = None
    if req.age_buckets is not None:
        ab = {k: np.asarray(v, dtype=float) for k, v in req.age_buckets.as_dict().items()}
        if ab:
            tot_b = sum(float(v[pre].sum()) for v in ab.values())
            age_ratio = {k: _ratio(v, pre, post) for k, v in ab.items()}
            age_share = {k: (float(v[pre].sum()) / tot_b if tot_b > 0 else 0.0) for k, v in ab.items()}
    dom_out: list[DomainBreadth] | None = None
    linked_ratio = unlinked_ratio = unlinked_share = None
    if req.domains is not None or req.unlinked_impressions is not None:
        dser = {d.domain: np.asarray(d.impressions, dtype=float) for d in (req.domains or [])}
        un = np.asarray(req.unlinked_impressions, dtype=float) if req.unlinked_impressions is not None else None
        tot_b = sum(float(v[pre].sum()) for v in dser.values()) + (float(un[pre].sum()) if un is not None else 0.0)
        if tot_b <= 0:
            tot_b = float(x[pre].sum())
        if dser:
            dom_out = sorted([DomainBreadth(domain=k, ratio=_ratio(v, pre, post),
                                            share_before=float(v[pre].sum()) / tot_b if tot_b > 0 else 0.0)
                              for k, v in dser.items()], key=lambda d: -d.share_before)
            linked_ratio = _ratio(np.sum(list(dser.values()), axis=0), pre, post)
        if un is not None:
            unlinked_ratio = _ratio(un, pre, post)
            unlinked_share = float(un[pre].sum()) / tot_b if tot_b > 0 else 0.0

    # decomposition
    contribs: list[PinContribution] = []
    top_pin_share = top1 = g = None
    n_pins = 0
    if req.pins:
        before_d = {p.pin_id: p.before for p in req.pins}
        after_d = {p.pin_id: p.after for p in req.pins}
        rows = pin_contributions(before_d, after_d)
        total_delta = sum(r[1] for r in rows)
        contribs = [PinContribution(pin_id=i, delta=d, share=s) for i, d, s in rows[:20]]
        if total_delta < 0 and rows and rows[0][1] < 0:
            top_pin_share = float(rows[0][1] / total_delta)
        bv = np.array([p.before for p in req.pins], dtype=float)
        n_pins = len(bv)
        if bv.sum() > 0:
            k1 = max(1, int(np.ceil(0.01 * n_pins)))
            top1 = float(np.sort(bv)[::-1][:k1].sum() / bv.sum())
        g = gini(bv)

    feats = Features(rate=rate, shape=shp, age=age_ratio, age_share=age_share, domains=dom_out,
                     linked_ratio=linked_ratio, unlinked_ratio=unlinked_ratio, unlinked_share=unlinked_share,
                     top_pin_share=top_pin_share, top1_share=top1, n_pins=n_pins, save_rate=save_rate,
                     signals=sig_in, spike=spike)
    sc = classify(feats)
    ranked = softmax(sc.scores)

    head = Evidence(code="drop_detected", supports=[], text=(
        f"Impressions fell {_pct(1 - ratio)} (median {b_med:,.0f} → {a_med:,.0f} per day) from "
        f"{_date(req, t0) or f'day {t0}'}" + (f"; one-sided Mann–Whitney p = {p_value:.2g}" if p_value is not None
                                              else "") + "."))
    agree_ev = Evidence(code="methods_agree" if agree else "methods_disagree", supports=[], text=(
        "Two changepoint methods (least-squares PELT and rank-based PELT) agree on the date within ±2 days."
        if agree else "The rank-based changepoint method does not confirm this date within ±2 days; treat the date "
        "as approximate."))
    evidence = [head, agree_ev] + sc.evidence

    w_idx = next((a for a in cus.alarms if a >= t0 - 2), None)
    top_p = ranked[0][1]
    margin = top_p - ranked[1][1]
    confidence: Literal["low", "medium", "high"]
    if agree and top_p >= 0.6 and margin >= 0.25 and rate.verdict != "insufficient":
        confidence = "high"
    elif top_p >= 0.4 and (agree or top_p >= 0.55):
        confidence = "medium"
    else:
        confidence = "low"

    age_out = None
    if age_ratio is not None:
        age_out = AgeBreadth.model_validate({k: age_ratio.get(k) for k in AGE_KEYS})
    return DiagnoseResponse(
        status="drop", onset_index=t0, onset_date=_date(req, t0), warning_index=w_idx,
        warning_date=_date(req, w_idx),
        drop=DropOut(before_median=b_med, after_median=a_med, ratio=ratio, effect=1 - ratio),
        methods_agree=agree, p_value=p_value,
        rate=RateOut(verdict=rate.verdict, log_bf=rate.log_bf, ctr_before=rate.before, ctr_after=rate.after,
                     post_impressions=rate.post_n),
        breadth=BreadthOut(age=age_out, domains=dom_out, linked_ratio=linked_ratio, unlinked_ratio=unlinked_ratio),
        pin_contributions=contribs,
        concentration=ConcentrationOut(top1_share=top1, top_pin_share=top_pin_share, gini=g),
        shape=shp.shape,  # type: ignore[arg-type]
        classes=[ClassProb(cause=c, probability=p) for c, p in ranked],  # type: ignore[arg-type]
        evidence=evidence, confidence=confidence, detector_version=DETECTOR_VERSION)
