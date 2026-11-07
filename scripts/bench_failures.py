"""List synthetic accounts the detector gets wrong, for the detector-loop skill.
Usage: python scripts/bench_failures.py [--seed 7] [--n 300] [--kind miss|false|class]
"""
from __future__ import annotations

import argparse
import sys
import pathlib

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "services" / "analytics"))
from pinpulse_analytics.detectors import Signals, diagnose  # noqa: E402
from pinpulse_analytics.synth import make_benchmark  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--seed", type=int, default=7)
ap.add_argument("--n", type=int, default=300)
ap.add_argument("--kind", default="miss")
a = ap.parse_args()

for i, (sig, truth) in enumerate(make_benchmark(a.seed, a.n)):
    dg = diagnose(Signals(**sig))
    det = dg.drop is not None
    if a.kind == "miss" and truth.onset is not None and not (det and abs(dg.onset_index - truth.onset) <= 2):
        print(f"#{i} MISS truth={truth} detected_onset={dg.onset_index} level~{sig['impressions'][:7].mean():.0f}")
    elif a.kind == "false" and truth.onset is None and det:
        print(f"#{i} FALSE onset={dg.onset_index} ratio={dg.drop.ratio:.2f}")
    elif a.kind == "class" and truth.onset is not None and det and abs(dg.onset_index - truth.onset) <= 2 and dg.ranked[0][0] != truth.cls:
        print(f"#{i} CLASS truth={truth.cls} got={dg.ranked[0][0]} scores={ {k: round(v, 2) for k, v in dg.ranked[:3]} } ev={dg.evidence}")
