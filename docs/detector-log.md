# Detector log
| Date | Commit | onset_f1 | class_acc | far | score | Hypothesis / outcome |
| --- | --- | --- | --- | --- | --- | --- |
| 2026-11-07 | seed | 0.828 | 0.717 | 0.098 | 0.799 | Baseline: PELT(log1p, BIC-like penalty, MAD sigma) + rule classifier |
| 2026-11-07 | review-fix | 0.817 | 0.640 | 0.086 | 0.766 | Removed label leakage from synth side-signals (noisy, incomplete; peers_hit_fraction=None in v1); E_decay onset relabelled to the viral peak; B scored when rates fall; added step-vs-fade shape rule; added delay, per-class accuracy, confusion, naive-rule F1 (0.29). Honest baseline. Weakest: E_decay 0.00, A_enforcement 0.31 (A vs D is structurally ambiguous without peer or domain-breadth data: next hypothesis = per-domain breadth signal). |
