---
name: detector-loop
description: Run the PinPulse detector improvement loop — pick the weakest benchmark metric, hypothesise one change to pinpulse_analytics, implement with tests, re-run the benchmark, keep only improvements, log the attempt. Use when asked to "improve the detector", "raise the benchmark", or "run a detector loop".
---

# Detector improvement loop

Goal: raise `python -m pinpulse_analytics.benchmark` score without breaking `pytest`. One hypothesis per iteration. Max 8 iterations per session, then report.

## Loop
1. Run `python -m pinpulse_analytics.benchmark --json` and `pytest -q`. Record all metrics in `docs/detector-log.md` (date, commit, metrics).
2. Pick the weakest of: onset_recall, onset_precision, class_accuracy, false_alarm_rate.
3. Write ONE hypothesis in the log, e.g. "recall is low on small-level accounts because MAD sigma floor 0.05 is too high; try 0.02", or "class accuracy confuses A vs D; weight peers_hit_fraction higher".
4. Write a failing unit test that captures the specific failure (find 3 failing synthetic accounts via `scripts/bench_failures.py`, assert on one).
5. Make the smallest change in `detectors.py`. Do not touch `synth.py` (the benchmark is frozen; changing it is a human decision).
6. Re-run benchmark on seeds 7, 11, 23 with n=300. Accept only if mean score improves ≥ 0.005 AND no metric drops > 0.02 AND pytest passes.
7. Accepted → update `benchmark_baseline.json` (seed 7), commit with message `detector: <hypothesis> (+0.0xx)`. Rejected → `git checkout -- .` and log why.
8. After 8 iterations or 3 consecutive rejections, stop and write a summary with the next 3 hypotheses.

## Rules
- No lookahead: detectors must only use data available at the alert date (no future days).
- Keep functions pure and typed; add a docstring with the math for any new statistic.
- If an improvement needs a new signal from the API, open a spec stub instead of faking it in synth.
- Never raise `min_drop` above 0.5 or widen the ±2-day match to pass the benchmark.
