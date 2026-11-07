"""Detector benchmark: the objective score the agent loop climbs.

Usage:  python -m pinpulse_analytics.benchmark  [--seed 7] [--n 300] [--json]
Scores:
  onset_recall    : fraction of true cliffs detected within ±2 days
  onset_precision : fraction of detections that match a true cliff within ±2 days
  false_alarm_rate: detections on accounts with no cliff
  class_accuracy  : top-1 cause class correct among detected true cliffs
  score           : 0.4*F1(onset) + 0.4*class_accuracy + 0.2*(1 - false_alarm_rate)
The CI gate (see .github/workflows/ci.yml) fails if score regresses below BASELINE in benchmark_baseline.json.
"""
from __future__ import annotations

import argparse
import json

import numpy as np

from .detectors import Signals, diagnose
from .synth import make_benchmark


def run(seed: int = 7, n: int = 300) -> dict:
    data = make_benchmark(seed, n)
    tp = fp = fn = 0
    cls_ok = cls_n = 0
    no_cliff = no_cliff_fired = 0
    for sig, truth in data:
        dg = diagnose(Signals(**sig))
        detected = dg.drop is not None
        if truth.onset is None:
            no_cliff += 1
            if detected:
                no_cliff_fired += 1; fp += 1
            continue
        if detected and abs(dg.onset_index - truth.onset) <= 2:
            tp += 1
            cls_n += 1
            if dg.ranked[0][0] == truth.cls:
                cls_ok += 1
        elif detected:
            fp += 1; fn += 1
        else:
            fn += 1
    prec = tp / (tp + fp) if tp + fp else 0.0
    rec = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * prec * rec / (prec + rec) if prec + rec else 0.0
    far = no_cliff_fired / no_cliff if no_cliff else 0.0
    acc = cls_ok / cls_n if cls_n else 0.0
    return dict(onset_precision=prec, onset_recall=rec, onset_f1=f1, false_alarm_rate=far,
                class_accuracy=acc, score=0.4 * f1 + 0.4 * acc + 0.2 * (1 - far), n=n, seed=seed)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--n", type=int, default=300)
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    r = run(a.seed, a.n)
    print(json.dumps(r, indent=2) if a.json else "\n".join(f"{k:18s} {v:.3f}" if isinstance(v, float) else f"{k:18s} {v}" for k, v in r.items()))
