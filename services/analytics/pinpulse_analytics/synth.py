"""Synthetic Pinterest-like accounts with known ground truth (benchmark v2).

The generator works at the Pin level so every breadth series the detector sees (age buckets, per-domain,
unlinked, per-Pin totals) is a SUM over simulated Pins, never a copy of the label:

  mean[p, t] = level * w_p * f(t - created_p) * weekly(t) * trend(t) * class_mult[p, t]
  count[p, t] ~ NegBin(mean[p, t] * g_t, k_pin),  g_t ~ Gamma(r, 1/r)  (shared daily shock)

f is a Pin lifecycle (fresh boost from the fresh-Pin candidate path, then a long tail). Pins belong to one of
1-4 link domains or are unlinked. Cause classes act on Pins:

  A_enforcement  every Pin linking to ONE domain loses 85-99% (Pinterest applies "the same enforcement to all
                 Pins with links belonging to the same domain"); other domains and unlinked Pins hold.
  B_quality      all Pins fall (heterogeneously) AND click/save rates fall.
  C_behavioural  Pins published from a week before onset get ~no distribution; older Pins take a smaller hit.
  D_platform     half: broad cut across all ages and domains; half: retrieval-side cut (Pins older than 7 days
                 lose 85-98%, fresh Pins untouched; the Aug-2026 community measurement). Rates stable.
  E_decay        one viral Pin plateaus then fades smoothly; onset = start of the fade.
  none           plain, strong weekly seasonality, a holiday dip that recovers, or a slow seasonal decline.

Side signals stay NOISY and INCOMPLETE (each observed only part of the time, each fires spuriously elsewhere),
`peers_hit_fraction` is None (no pooled data in v1, PA-06), and 25% of accounts have no breadth data at all
(CSV-only users), so the classifier cannot read the label off any single input.

The last `PROVISIONAL_DAYS` days are under-counted (reporting lag, PA-08); `Account.request_at(t)` rebuilds the
request as it would have looked on day t, applying the lag to that day's tail (used for lead-time scoring).
"""
from __future__ import annotations

import datetime as dt
from collections.abc import Iterator
from dataclasses import dataclass, field

import numpy as np

CLASSES = ["A_enforcement", "B_quality", "C_behavioural", "D_platform", "E_decay"]
CLASS_P = [0.2, 0.15, 0.2, 0.35, 0.1]
AGE_EDGES = (("0-7", 0, 7), ("8-14", 8, 14), ("15-29", 15, 29), ("30+", 30, 10**9))
START = dt.date(2026, 1, 1)
PROVISIONAL_DAYS = 2


@dataclass
class Truth:
    onset: int | None
    drop: float | None
    cls: str | None      # CauseClass label or None
    variant: str = ""    # sub-scenario, for analysis only (never passed to the detector)


@dataclass
class Account:
    """Complete (lag-free) simulated data for one account plus the observation model."""
    pin_counts: np.ndarray            # (P, n) int
    created: np.ndarray               # (P,) creation day (may be negative)
    pin_domain: np.ndarray            # (P,) domain index, -1 = unlinked
    domains: list[str]
    clicks: np.ndarray                # (n,)
    saves: np.ndarray
    pin_clicks: np.ndarray
    lag: np.ndarray                   # multiplicative under-count for the last PROVISIONAL_DAYS days
    breadth: bool                     # whether per-Pin data is available (False = CSV-only user)
    signals: dict
    truth: Truth
    n: int = field(init=False)

    def __post_init__(self) -> None:
        self.n = self.pin_counts.shape[1]

    def _lagged(self, m: np.ndarray, t_end: int) -> np.ndarray:
        """Rows of m (…, n) truncated to day t_end inclusive, with the reporting lag on the tail."""
        out = np.array(m[..., : t_end + 1], dtype=float)
        for j, f in enumerate(self.lag):
            if t_end - j >= 0:
                out[..., t_end - j] = np.floor(out[..., t_end - j] * f)
        return out

    def request_at(self, t_end: int | None = None, onset_hint: int | None = None) -> dict:
        """The /v1/diagnose request the web app would send on day t_end (default: last day).

        `onset_hint` is a DETECTED onset (from a first pass) used only to compute per-Pin before/after totals,
        exactly as the web app does; it is never the true onset.
        """
        t_end = self.n - 1 if t_end is None else t_end
        pc = self._lagged(self.pin_counts, t_end)
        impressions = pc.sum(axis=0)
        req: dict = {
            "dates": [(START + dt.timedelta(days=i)).isoformat() for i in range(t_end + 1)],
            "impressions": impressions.tolist(),
            "outbound_clicks": self._lagged(self.clicks, t_end).tolist(),
            "saves": self._lagged(self.saves, t_end).tolist(),
            "pin_clicks": self._lagged(self.pin_clicks, t_end).tolist(),
            "provisional_days": PROVISIONAL_DAYS,
            "signals": dict(self.signals),
        }
        if not self.breadth:
            return req
        days = np.arange(t_end + 1)
        age = days[None, :] - self.created[:, None]
        buckets = {}
        for key, lo, hi in AGE_EDGES:
            mask = (age >= lo) & (age <= hi)
            buckets[key] = (pc * mask).sum(axis=0).tolist()
        req["age_buckets"] = buckets
        req["domains"] = [{"domain": d, "impressions": pc[self.pin_domain == i].sum(axis=0).tolist()}
                          for i, d in enumerate(self.domains)]
        req["unlinked_impressions"] = pc[self.pin_domain == -1].sum(axis=0).tolist()
        if onset_hint is not None:
            conf_end = t_end + 1 - PROVISIONAL_DAYS
            b0, a1 = max(0, onset_hint - 14), min(conf_end, onset_hint + 14)
            if a1 > onset_hint and onset_hint > b0:
                before = pc[:, b0:onset_hint].sum(axis=1)
                after = pc[:, onset_hint:a1].sum(axis=1) * (onset_hint - b0) / (a1 - onset_hint)
                live = (before + after) > 0
                req["pins"] = [{"pin_id": str(i), "before": float(before[i]), "after": float(after[i])}
                               for i in np.flatnonzero(live)]
        return req


def _lifecycle(age: np.ndarray, tau_long: float) -> np.ndarray:
    a = np.maximum(age, 0.0)
    f = (1.5 * np.exp(-a / 10.0) + 0.5 * np.exp(-a / tau_long)) * (1 - np.exp(-(a + 1) / 1.5))
    return np.where(age >= 0, f, 0.0)


def _nb(rng: np.random.Generator, mean: np.ndarray, k: float) -> np.ndarray:
    mean = np.maximum(mean, 1e-12)
    return rng.negative_binomial(k, k / (k + mean))


UNLABELLED_DROP_MAX = 0.35
PIN_DISPERSION = 10.0


def _max_unlabelled_drop(total_mean: np.ndarray, start: int = 7, w: int = 14) -> float:
    """Largest 14-vs-14 or 7-vs-7-day fall of a noise-free mean at days >= start (label hygiene)."""
    worst = 0.0
    for t in range(max(7, start), len(total_mean) - 7):
        worst = max(worst, _window_drop(total_mean, t, w), _window_drop(total_mean, t, 7))
    return worst


def _window_drop(total_mean: np.ndarray, onset: int, w: int = 14) -> float:
    b = total_mean[max(0, onset - w):onset].mean()
    a = total_mean[onset:onset + w].mean()
    return float(1 - a / b)


def make_account(rng: np.random.Generator, n: int = 90, cliff: bool = True) -> Account:  # noqa: C901
    t = np.arange(n)
    is_cliff = cliff and rng.uniform() < 0.8
    cls = str(rng.choice(CLASSES, p=CLASS_P)) if is_cliff else None
    for _attempt in range(500):
        level = float(np.exp(rng.uniform(np.log(200), np.log(50_000))))
        r_day = rng.uniform(5, 15)
        seasonal_kind = rng.uniform()
        amp = rng.uniform(0.25, 0.45) if seasonal_kind < 0.15 else rng.uniform(0.03, 0.18)
        weekly = 1 + amp * np.sin(2 * np.pi * t / 7 + rng.uniform(0, 2 * np.pi))
        trend = np.exp(rng.normal(0, 0.002) * t)
        if cls == "C_behavioural":   # behavioural suppression only produces a cliff on fresh-content accounts
            pub_rate, tau_long = rng.uniform(1.5, 4.0), float(rng.uniform(12, 45))
        else:
            pub_rate, tau_long = rng.uniform(0.3, 2.0), float(np.exp(rng.uniform(np.log(25), np.log(400))))
        span = min(5 * tau_long, 400)
        n_pins = max(5, int(rng.poisson(pub_rate * (span + n))))
        created = np.sort(rng.uniform(-span, n, n_pins)).astype(int)
        w = rng.lognormal(0, rng.uniform(0.8, 1.6), n_pins)
        # domains: 1-4 link domains plus unlinked Pins
        k_dom = int(rng.choice([1, 2, 3, 4], p=[0.45, 0.3, 0.15, 0.1]))
        dom_share = rng.dirichlet(np.ones(k_dom) * 1.2)
        unlinked = rng.uniform(0.03, 0.35)
        if cls == "A_enforcement":
            dom_share = np.sort(dom_share)[::-1]
            dom_share[0] = max(dom_share[0], rng.uniform(0.6, 0.95))
            dom_share = dom_share / dom_share.sum()
            unlinked = rng.uniform(0.03, 0.25)
        probs = np.concatenate([[unlinked], (1 - unlinked) * dom_share])
        pin_domain = rng.choice(np.arange(-1, k_dom), size=n_pins, p=probs)
        names = rng.choice(["shop", "blog", "store", "recipes", "studio", "co", "home", "learn"], k_dom, replace=False)
        domains = [f"{nm}-{rng.integers(10, 99)}.com" for nm in names]

        age = t[None, :] - created[:, None]
        base = w[:, None] * _lifecycle(age.astype(float), tau_long)
        scale = level / max(base.sum(axis=0).mean(), 1e-9)
        base = base * scale
        organic = base.sum(axis=0) * trend   # noise-free mean without any class effect
        mult = np.ones_like(base)
        truth = Truth(None, None, None, "plain")
        ctr_mult = np.ones(n)

        if cls is not None:
            onset = int(rng.integers(20, n - 15))
            post = t >= onset
            variant = cls
            if cls == "A_enforcement":
                mult[pin_domain == 0] = np.where(post, 1 - rng.uniform(0.85, 0.99), 1.0)
            elif cls == "B_quality":
                drop = rng.uniform(0.5, 0.97)
                het = np.clip(np.exp(rng.normal(np.log(1 - drop), 0.25, n_pins)), 0, 1)
                mult = np.where(post[None, :], het[:, None], 1.0)
                ctr_mult = np.where(post, rng.uniform(0.45, 0.7), 1.0)
            elif cls == "C_behavioural":
                old_m = rng.uniform(0.3, 0.8)
                fresh = created >= onset - 7
                mult = np.where(post[None, :], np.where(fresh[:, None], 0.04, old_m), 1.0)
            elif cls == "D_platform":
                if rng.uniform() < 0.5:
                    variant = "D_broad"
                    drop = rng.uniform(0.5, 0.97)
                    het = np.clip(np.exp(rng.normal(np.log(1 - drop), 0.2, n_pins)), 0, 1)
                    mult = np.where(post[None, :], het[:, None], 1.0)
                else:
                    variant = "D_retrieval"
                    dm = rng.uniform(0.85, 0.98)
                    mult = np.where(post[None, :] & (age > 7), 1 - dm, 1.0)
            elif cls == "E_decay":
                plateau = int(rng.integers(8, 21))
                v_amp = rng.uniform(1.5, 6.0)
                tau_v = rng.uniform(2.5, 7.0)
                c0 = onset - plateau
                ramp = np.clip((t - c0 + 1) / 3.0, 0, 1)
                vm = np.where(t < onset, ramp * np.exp(-np.maximum(t - c0, 0) / 60.0),
                              np.exp(-(plateau / 60.0)) * np.exp(-(t - onset) / tau_v))
                viral = level * v_amp * vm
                dom = int(rng.choice(np.arange(-1, k_dom), p=probs))
                base = np.vstack([base, viral[None, :]])
                mult = np.vstack([mult, np.ones((1, n))])
                created = np.append(created, c0)
                pin_domain = np.append(pin_domain, dom)
                n_pins += 1
            if cls != "B_quality":
                # audience-mix shift: after any cut the remaining audience converts a little differently
                ctr_mult = np.where(post, float(np.exp(rng.normal(0, 0.15))), 1.0)
            total = (base * mult).sum(axis=0) * trend
            realized = _window_drop(total, onset)
            if realized < 0.5:
                continue  # not a cliff under the product definition; redraw the account
            if (_max_unlabelled_drop(organic) >= UNLABELLED_DROP_MAX
                    or _max_unlabelled_drop(total, start=onset + 14) >= UNLABELLED_DROP_MAX):
                continue  # organic Pin dynamics produced a second, unlabelled cliff: redraw (label hygiene)
            truth = Truth(onset, realized, cls, variant)
        else:
            k = rng.uniform()
            if k < 0.25:
                d0, d_len = int(rng.integers(15, n - 20)), int(rng.integers(2, 7))
                acc = np.ones(n)
                acc[d0:d0 + d_len] = 1 - rng.uniform(0.3, 0.6)
                mult = mult * acc[None, :]
                truth = Truth(None, None, None, "holiday_dip")
            elif k < 0.4:
                d0, d_len = int(rng.integers(10, n - 40)), int(rng.integers(30, 60))
                acc = np.ones(n)
                depth = rng.uniform(0.2, 0.4)
                ramp = np.clip((t - d0) / d_len, 0, 1)
                acc = 1 - depth * ramp
                mult = mult * acc[None, :]
                truth = Truth(None, None, None, "seasonal_decline")
            elif amp > 0.25:
                truth = Truth(None, None, None, "strong_weekly")
            if _max_unlabelled_drop(organic) >= UNLABELLED_DROP_MAX:
                continue  # a heavy fresh Pin fading is a real (unlabelled) drop: redraw the no-cliff account
        break
    else:
        raise RuntimeError("synthetic account rejected 500 times; generator constraints are inconsistent")

    mean = base * mult * (weekly * trend)[None, :]
    g = rng.gamma(r_day, 1 / r_day, n)
    pin_counts = _nb(rng, mean * g[None, :], PIN_DISPERSION)
    impressions = pin_counts.sum(axis=0)
    ctr = rng.uniform(0.005, 0.04) * ctr_mult * np.exp(rng.normal(0, 0.15, n))
    clicks = rng.binomial(impressions, np.clip(ctr, 0, 1))
    save_r = rng.uniform(0.002, 0.02) * (ctr_mult if truth.cls == "B_quality" else 1.0) * np.exp(rng.normal(0, 0.15, n))
    saves = rng.binomial(impressions, np.clip(save_r, 0, 1))
    pclick = rng.binomial(impressions, np.clip(rng.uniform(0.01, 0.05) * np.exp(rng.normal(0, 0.1, n)), 0, 1))
    lag = np.array([rng.uniform(0.55, 0.9), rng.uniform(0.8, 1.0)])

    c = truth.cls
    dup_true = c == "C_behavioural" and rng.uniform() < 0.4
    signals = dict(
        domain_block_error=bool((c == "A_enforcement" and rng.uniform() < 0.35) or rng.uniform() < 0.04),
        visit_site_demoted=bool((c == "B_quality" and rng.uniform() < 0.35) or rng.uniform() < 0.06),
        bulk_upload_or_ad_prefix=bool((c == "C_behavioural" and rng.uniform() < 0.4) or rng.uniform() < 0.08),
        duplicate_url_rate_14d=float(rng.uniform(0.5, 0.9)) if dup_true or rng.uniform() < 0.05
        else float(rng.uniform(0, 0.3)),
        peers_hit_fraction=None,  # v1 has no pooled peer data (PA-06)
        yoy_same_window_ratio=(float(np.clip(rng.normal(0.65, 0.12), 0.2, 1.2))
                               if truth.variant == "seasonal_decline" and rng.uniform() < 0.5 else None),
    )
    return Account(pin_counts=pin_counts, created=created, pin_domain=pin_domain, domains=domains,
                   clicks=clicks, saves=saves, pin_clicks=pclick, lag=lag, breadth=bool(rng.uniform() < 0.75),
                   signals=signals, truth=truth)


def iter_benchmark(seed: int = 7, n_accounts: int = 300, n: int = 90) -> Iterator[Account]:
    rng = np.random.default_rng(seed)
    for _ in range(n_accounts):
        yield make_account(rng, n=n)


def make_benchmark(seed: int = 7, n_accounts: int = 300) -> list[tuple[dict, Truth]]:
    """(request, truth) pairs for the final day of each account, without per-Pin totals."""
    return [(a.request_at(), a.truth) for a in iter_benchmark(seed, n_accounts)]
