"""List synthetic accounts the detector gets wrong, for the detector-loop skill.
Usage: python scripts/bench_failures.py [--seed 7] [--n 300] [--kind miss|false|class] [--cls E_decay]

Uses the benchmark's own run_account(), so what it lists is exactly what the benchmark scores.
"""
from __future__ import annotations

import argparse
import pathlib
import sys

import numpy as np

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "services" / "analytics"))
from pinpulse_analytics.benchmark import run_account  # noqa: E402
from pinpulse_analytics.synth import iter_benchmark  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--seed", type=int, default=7)
ap.add_argument("--n", type=int, default=300)
ap.add_argument("--kind", default="miss", choices=["miss", "false", "class"])
ap.add_argument("--cls", default=None, help="only accounts whose true class is this (e.g. E_decay)")
a = ap.parse_args()

for i, acc in enumerate(iter_benchmark(a.seed, a.n)):
    t = acc.truth
    if a.cls and t.cls != a.cls:
        continue
    dg = run_account(acc)
    x = np.asarray(acc.request_at()["impressions"], dtype=float)
    det = dg.status == "drop" and dg.onset_index is not None
    hit = det and t.onset is not None and abs(dg.onset_index - t.onset) <= 2  # type: ignore[operator]
    if a.kind == "miss" and t.onset is not None and not hit:
        print(f"#{i} MISS {t.cls}/{t.variant} onset={t.onset} drop={t.drop} got status={dg.status} onset={dg.onset_index} "
              f"shape={dg.shape} level~{x[:14].mean():.0f} evidence={[e.code for e in dg.evidence][:4]}")
    elif a.kind == "false" and t.onset is None and det:
        print(f"#{i} FALSE {t.variant} onset={dg.onset_index} effect={dg.drop.effect if dg.drop else None}")
    elif a.kind == "class" and hit and dg.classes and dg.classes[0].cause != t.cls:
        print(f"#{i} CLASS truth={t.cls}/{t.variant} got={dg.classes[0].cause} "
              f"top3={[(c.cause, round(c.probability, 2)) for c in dg.classes[:3]]}")
