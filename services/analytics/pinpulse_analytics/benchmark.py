"""Detector benchmark (v2 generator): the objective score the agent loop climbs.

Usage:  python -m pinpulse_analytics.benchmark [--seed 7] [--n 300] [--json] [--seeds 7,11,23] [--no-lead]
        python -m pinpulse_analytics.benchmark --tune-cusum

Each account goes through the SAME code path as the API: a `DiagnoseRequest` is validated by pydantic and passed
to `detectors.diagnose`. Like the web app, a first pass without per-Pin totals gives a detected onset; if a drop
is found, per-Pin before/after totals are computed around that DETECTED onset and a second pass is run.

Scores:
  onset_precision/recall/f1 : detected onset within +/-2 days of the true cliff
  false_alarm_rate          : confirmed drops on accounts with no cliff (includes seasonal/holiday-dip cases)
  class_accuracy            : top-1 cause correct among detected true cliffs (top2 also reported)
  score                     : 0.4*F1 + 0.4*class_accuracy + 0.2*(1 - FAR)
  mean_onset_error_days     : detected onset - true onset (signed) on matched cliffs
  mean_detection_delay_days : first day the drop is confirmed (data through that day) - true onset
  warning_lead_days         : confirmation day - first CUSUM warning day (causal), on matched cliffs
  cusum_false_alarms_per_account_year : CUSUM alarms on complete history of no-cliff accounts
  naive_rule_f1             : hand rule "7-day median fell >= 50% vs prior 7 days"
"""
from __future__ import annotations

import argparse
import json
from collections.abc import Iterable

import numpy as np

from . import detectors
from .detectors import cusum_drop, diagnose
from .schemas import DiagnoseRequest, DiagnoseResponse
from .synth import CLASSES, PROVISIONAL_DAYS, Account, iter_benchmark

ABSOLUTE_FLOOR = 0.6


def naive_rule(x: np.ndarray) -> int | None:
    """Baseline a VA might apply by hand: 7-day median falls >= 50% vs the prior 7-day median."""
    for t in range(14, len(x)):
        before = float(np.median(x[t - 14:t - 7]))
        after = float(np.median(x[t - 7:t]))
        if before > 0 and after / before <= 0.5:
            return t - 7
    return None


def run_account(acc: Account, t_end: int | None = None) -> DiagnoseResponse:
    """Two-pass diagnosis exactly as the web app performs it."""
    first = diagnose(DiagnoseRequest.model_validate(acc.request_at(t_end)))
    if first.status != "drop" or not acc.breadth:
        return first
    return diagnose(DiagnoseRequest.model_validate(acc.request_at(t_end, onset_hint=first.onset_index)))


def _confirm_day(acc: Account, onset: int) -> int | None:
    """First day t (data through t, last PROVISIONAL_DAYS lagged) on which the drop is confirmed near onset."""
    for t in range(onset + detectors.MIN_POST_DAYS - 1 + PROVISIONAL_DAYS, min(acc.n, onset + 30)):
        r = diagnose(DiagnoseRequest.model_validate(acc.request_at(t)))
        if r.status == "drop" and r.onset_index is not None and abs(r.onset_index - onset) <= 2:
            return t
    return None


def _first_warning_day(acc: Account, onset: int, until: int) -> int | None:
    """First day t in [onset - 2, until) on which the API would answer status 'warning' with data through t."""
    for t in range(max(onset - 2, 14), until):
        x = np.asarray(acc.request_at(t)["impressions"], dtype=float)
        if detectors.early_warning(x, PROVISIONAL_DAYS) is not None:
            return t
    return None


def cusum_far(accounts: Iterable[Account], h_mult: float) -> float:
    """CUSUM alarms per account-year on complete (lag-free) no-cliff histories."""
    alarms = days = 0
    for a in accounts:
        if a.truth.onset is not None:
            continue
        x = a.pin_counts.sum(axis=0).astype(float)
        r = cusum_drop(x, h_mult=h_mult)
        alarms += len(r.alarms)
        days += max(0, len(x) - detectors.CUSUM_BASELINE)
    return alarms / days * 365 if days else 0.0


def run(seed: int = 7, n: int = 300, lead: bool = True) -> dict:  # noqa: C901
    tp = fp = fn = 0
    cls_ok = cls_top2 = cls_n = 0
    no_cliff = no_cliff_fired = no_cliff_warned = 0
    onset_err: list[int] = []
    delays: list[int] = []
    leads: list[int] = []
    confusion: dict[str, dict[str, int]] = {}
    per: dict[str, dict[str, int]] = {c: {"n": 0, "detected": 0, "correct": 0} for c in CLASSES}
    nb = {"n": 0, "correct": 0}  # matched cliffs without breadth data
    fa_variants: dict[str, int] = {}
    naive_tp = naive_fp = naive_fn = 0
    accounts = list(iter_benchmark(seed, n))
    for acc in accounts:
        truth = acc.truth
        dg = run_account(acc)
        detected = dg.status == "drop"
        nv = naive_rule(np.asarray(acc.request_at()["impressions"]))
        if truth.onset is None:
            no_cliff += 1
            if detected:
                no_cliff_fired += 1
                fp += 1
                fa_variants[truth.variant] = fa_variants.get(truth.variant, 0) + 1
            if dg.status == "warning":
                no_cliff_warned += 1
            if nv is not None:
                naive_fp += 1
            continue
        assert truth.cls is not None
        per[truth.cls]["n"] += 1
        if nv is not None and abs(nv - truth.onset) <= 2:
            naive_tp += 1
        elif nv is not None:
            naive_fp += 1
            naive_fn += 1
        else:
            naive_fn += 1
        if detected and dg.onset_index is not None and abs(dg.onset_index - truth.onset) <= 2:
            tp += 1
            cls_n += 1
            per[truth.cls]["detected"] += 1
            onset_err.append(dg.onset_index - truth.onset)
            got = dg.classes[0].cause
            confusion.setdefault(truth.cls, {})[got] = confusion.setdefault(truth.cls, {}).get(got, 0) + 1
            if got == truth.cls:
                cls_ok += 1
                per[truth.cls]["correct"] += 1
            if truth.cls in [c.cause for c in dg.classes[:2]]:
                cls_top2 += 1
            if not acc.breadth:
                nb["n"] += 1
                nb["correct"] += int(got == truth.cls)
            if lead:
                cday = _confirm_day(acc, truth.onset)
                if cday is not None:
                    delays.append(cday - truth.onset)
                    wd = _first_warning_day(acc, truth.onset, cday)
                    leads.append(cday - wd if wd is not None else 0)
        elif detected:
            fp += 1
            fn += 1
        else:
            fn += 1
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    far = no_cliff_fired / no_cliff if no_cliff else 0.0
    acc_ = cls_ok / cls_n if cls_n else 0.0
    nprec = naive_tp / (naive_tp + naive_fp) if naive_tp + naive_fp else 0.0
    nrec = naive_tp / (naive_tp + naive_fn) if naive_tp + naive_fn else 0.0
    nf1 = 2 * nprec * nrec / (nprec + nrec) if nprec + nrec else 0.0
    per_class = {c: dict(v, recall=(v["detected"] / v["n"] if v["n"] else 0.0),
                         accuracy=(v["correct"] / v["detected"] if v["detected"] else 0.0),
                         end_to_end=(v["correct"] / v["n"] if v["n"] else 0.0)) for c, v in per.items()}
    out = dict(
        onset_precision=prec, onset_recall=rec, onset_f1=f1, false_alarm_rate=far,
        class_accuracy=acc_, class_top2_accuracy=cls_top2 / cls_n if cls_n else 0.0,
        score=0.4 * f1 + 0.4 * acc_ + 0.2 * (1 - far),
        mean_onset_error_days=float(np.mean(onset_err)) if onset_err else 0.0,
        mean_abs_onset_error_days=float(np.mean(np.abs(onset_err))) if onset_err else 0.0,
        per_class_accuracy={c: v["accuracy"] for c, v in per_class.items()},
        per_class=per_class, confusion=confusion,
        class_accuracy_without_breadth=nb["correct"] / nb["n"] if nb["n"] else 0.0,
        false_alarms_by_variant=fa_variants,
        warning_rate_on_no_cliff_final_day=no_cliff_warned / no_cliff if no_cliff else 0.0,
        cusum_false_alarms_per_account_year=cusum_far(accounts, detectors.CUSUM_H_MULT),
        naive_rule_f1=nf1, n=n, seed=seed, generator="v2-pin-level", detector_version=detectors.DETECTOR_VERSION,
    )
    if lead:
        out.update(mean_detection_delay_days=float(np.mean(delays)) if delays else 0.0,
                   warning_lead_days=float(np.mean(leads)) if leads else 0.0,
                   warned_before_confirmation=float(np.mean([v > 0 for v in leads])) if leads else 0.0)
    return out


def tune_cusum(seeds: tuple[int, ...] = (7, 11, 23), n: int = 300, target: float = 1.0) -> dict:
    accs = [a for s in seeds for a in iter_benchmark(s, n) if a.truth.onset is None]
    grid = [round(h, 2) for h in np.arange(2.0, 8.01, 0.25)]
    rates = {h: cusum_far(accs, h) for h in grid}
    best = min(grid, key=lambda h: (abs(rates[h] - target), -h))
    return {"rates": rates, "best_h_mult": best, "no_cliff_accounts": len(accs)}


def _fmt(r: dict) -> str:
    lines = []
    for k, v in r.items():
        if isinstance(v, float):
            lines.append(f"{k:38s} {v:.3f}")
        elif isinstance(v, dict):
            lines.append(f"{k:38s} {json.dumps(v, default=float)}")
        else:
            lines.append(f"{k:38s} {v}")
    return "\n".join(lines)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--seeds", type=str, default="")
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--json", action="store_true")
    ap.add_argument("--no-lead", action="store_true")
    ap.add_argument("--tune-cusum", action="store_true")
    a = ap.parse_args()
    if a.tune_cusum:
        print(json.dumps(tune_cusum(n=a.n), indent=2))
    elif a.seeds:
        res = [run(int(s), a.n, lead=not a.no_lead) for s in a.seeds.split(",")]
        print(json.dumps(res, indent=2) if a.json else "\n\n".join(_fmt(r) for r in res))
    else:
        r = run(a.seed, a.n, lead=not a.no_lead)
        print(json.dumps(r, indent=2) if a.json else _fmt(r))
