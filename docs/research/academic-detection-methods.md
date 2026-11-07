# PinPulse detection/diagnosis engine: literature grounding report (7 Nov 2026)

Data regime: per-account and per-Pin daily counts (impressions, saves, pin clicks, outbound clicks), 90-day window, weekly seasonality, counts from single digits per Pin to millions per account, cliffs of 50–99%. "Derived" marks formulas reasoned from first principles rather than quoted.

Two empirical anchors:
- A creator's per-Pin v5-API measurement of an Aug-2026 cliff: account impressions 1,413 → 497 → 121 over 17–19 Aug; every Pin older than 7 days lost ~95% within 48 h while 0–7-day Pins were unchanged; pins visible on profile but not found by keyword search; other creators reported onsets 1, 8, 10, 12, 17–18 Aug. https://community.pinterest.biz/t/i-measured-my-august-drop-per-pin-every-pin-older-than-7-days-lost-95-in-48-hours-new-pins-untouched/50281 → an age-stratified cut concentrated in mature Pins is a distribution/retrieval-side cut, not content decay.
- Pinterest applies domain-level enforcement to all Pins linking to the same domain ("limiting distribution of Pins with spam links"). https://medium.com/pinterest-engineering/how-pinterest-fights-spam-using-machine-learning-d0ee2589f00a → Cause A presents as a drop across all Pins sharing a destination domain regardless of age.

## 1. Changepoint detection for short daily series

Papers: Adams & MacKay 2007 BOCPD (arXiv:0710.3742); Killick, Fearnhead & Eckley 2012 PELT (JASA, arXiv:1101.1438); Truong, Oudre & Vayatis 2020 ruptures review (arXiv:1801.00718); Knoblauch, Jewson & Damoulas 2018 robust BOCPD (NeurIPS); Page 1954 CUSUM; Bardwell et al. 2017 panel most-recent changepoint (arXiv:1609.06805).

- BOCPD: run-length posterior P(r_t, x_1:t) = Σ P(r_t|r_{t-1}) π_t^{(r)} P(r_{t-1}, x_1:{t-1}); growth and changepoint recursions with hazard H; conjugate exponential-family predictive; linear per step, trivial at 90 points.
- PELT: minimise Σ C(segments) + β m; F(s) = min_t {F(t) + C(y_{t+1:s}) + β}; prune t if F(t) + C + K ≥ F(s); expected linear cost; BIC penalty β = p log n.
- ruptures: cost × search × constraint; costs l2, poisson, rank, rbf; pen_BIC,L2 = σ² log T |T|; min_size and jump.
- CUSUM: C⁺ = max(0, x − (T+K) + C⁺_{prev}); alarm at h; ARL as false-alarm/delay measure; CUSUM = SPRT with the lower barrier at zero.
- Robust BOCPD: β-divergence loss cuts changepoint FDR "from up to 99% to 0%" on real data.

Fit: deseasonalise (STL remainder, 7-day sums, or NB-GLR with Fourier terms) first; use log1p or Poisson/NB cost; cliffs are large effects so the engineering problems are onset dating (±1 day), not flagging a viral Pin's decay, and multiple testing across accounts; 90 points is too short for data-driven penalty calibration, so fix β from BIC, min_size 7, validate on synthetic cliffs; per-Pin series need Poisson/NB models or 7-day sums.

Implementation v1: y = log1p(impressions); STL(period=7, robust); ruptures Pelt(l2, min_size=7, jump=1) with β = σ̂² log T (σ̂ = 1.4826·MAD of first differences); rank-cost cross-check within ±2 days; cliff if effect ≥ 0.5 and post-segment ≥ 7 days; CUSUM online with k = log(2)/2, h tuned to ARL₀ ≈ 365 days. v2: BOCPD (NIG or Poisson-Gamma), hazard 1/λ, λ ≈ 60–90, report P(r_t < 7); robust variant if viral spikes cause false alarms.

## 2. Seasonal count anomaly detection with 90 days

Papers: Hochenbaum, Vallis & Kejariwal 2017 S-ESD/S-H-ESD (arXiv:1704.07706); Cleveland et al. 1990 STL; Taylor & Letham 2018 Prophet; Höhle & Paul 2008 NB-GLR (`surveillance::algo.glrnb`).

- S-H-ESD: generalized ESD on residual X − S_X − median(X), median/MAD, k ≤ 0.49 n, α = 0.05, trailing 14 days in production; F-measure gains 17.5–29.5% over S-ESD.
- Prophet: g(t) + s(t) + h(t); Laplace-sparse trend changes; weekly Fourier N = 3; no minimum-data rule; poorly identified at 90 points.
- NB-GLR: y_t ~ NegBin(μ_t, α), log μ_0,t with linear trend and Fourier terms; out-of-control μ_1 = μ_0 e^κ; GLR(n) = max_k sup_κ Σ log-likelihood ratio; dir="dec" for decreases; threshold c_γ.

Fit: S-H-ESD is a point-anomaly detector and is contaminated once post-cliff days exceed half the window; Prophet is overkill; NB-GLR is the best single model for small counts and seasonality; account-level log-STL remainder + robust z is simplest. Baseline window [τ−35, τ−8].

## 3. Platform-wide vs local attribution

Papers: Brodersen et al. 2015 CausalImpact (AoAS, arXiv:1506.00356); Abadie, Diamond & Hainmueller 2010 synthetic control (JASA); Bardwell et al. 2017; Benjamini & Hochberg 1995.

- CausalImpact: BSTS with local linear trend, seasonal state, spike-and-slab regression on controls; Gibbs sampling; counterfactual draws; effect declared when the 95% posterior interval of the cumulative effect excludes 0; assumptions: controls unaffected, pre-period relation persists.
- Synthetic control: non-negative weights minimising pre-period distance; placebo inference (MSPE ratio); needs good pre-fit.
- Panel MRC: shared most-recent changepoint locations; per-series PELT then K-median assignment; β = (p + ½) log n.
- Simple robust test (derived): k of n accounts with onset in [d−2, d+2]; H₀ k ~ Binomial(n, p₀), p₀ ≈ 0.03·5/90 ≈ 0.0017; overdispersion via Beta-Binomial with precision φ from historical k/n; "platform-wide" at tail p < 0.001 and k/n ≥ 10%; stratify by niche/country/size.

Implementation v1: nightly onset histogram, Beta-Binomial tail p per day; expose "k of n monitored accounts cliffed within 2 days of you". v2: tfcausalimpact per account with leave-one-out pooled index; Bardwell panel model K ≤ 3.

## 4. Engagement-rate stability as a distribution-cut signature

Sources: Johari, Pekelis & Walsh 2015 mSPRT always-valid inference (arXiv:1512.04922); Wald SPRT via CUSUM lineage; Ibrahim & Girmay 2026 TikTok visibility audit (arXiv:2607.17356) — reach vs engagement-per-play decomposition; pooled hourly snapshots inflate significance (ICC 0.98, design effect ≈ 180).

Method (derived): Beta-Binomial posteriors for pre and post windows; ratio ρ = r_A/r_B by Monte Carlo; "rate stable" if P(0.7 < ρ < 1.3) > 0.8; "rate collapsed" if P(ρ < 0.5) > 0.8; daily overdispersion via scipy.stats.betabinom LRT; sequential mSPRT with mixing variance τ² ≈ (0.3 r_B)²; verdict only after ≥ 500 post impressions.

Interpretation: cliff + stable rates → upstream distribution cut (A, C, D); cliff + falling rates (esp. saves/impression) → quality down-ranking (B) or audience shift; age-stratified → retrieval-side; domain-concentrated → enforcement (A).

## 5. Attributing an account drop to Pins

Papers: Sharma, Li & Jiao ~2022 counterfactual Shapley (arXiv:2208.08399); Cha et al. 2007 YouTube popularity (IMC); Clauset, Shalizi & Newman 2009 power laws (SIAM Review).

- Additive metrics: Shapley value of a Pin = its own Δ (derived); ratio metrics (CTR): rate effect + mix effect decomposition, CF-Shapley with M ≈ 1000 subsets if needed.
- Heavy tails: top 10% of videos ≈ 80% of views; MLE α̂ = 1 + n[Σ ln(x_i/x_min)]⁻¹, x_min by KS (`powerlaw` package).
- Diagnostics: cumulative share ("3 Pins explain 82%"), top-1% share and Gini, breadth (fraction of Pins with ≥10 impressions/day that fell ≥80%), age-stratified ratios (0–7 / 8–14 / 15–29 / 30+ days).

## 6. Shadowban measurement and Pinterest ranking signals

Audits: Le Merrer, Morgan & Trédan 2021 (arXiv:2012.05101) — deterministic probes, 2.34% prevalence, neighbours of banned accounts banned 16.9% vs 2.1%, contagion likelihood ratio 2.68×; Ibrahim & Girmay 2026 — account as unit of inference, BH across tests; Delmonaco et al. 2024 CSCW — "collaborative algorithm investigation".

Pinterest ML: PinSage (arXiv:1806.01973) — embeddings from visual, text and the Pin–board graph; "Keeping Related Pins fresh" (2018) — fresh (≤7 day) Pins served through a separate candidate path; TransAct (arXiv:2306.00248) — multi-task heads incl. click, repin, hide; retrained twice weekly; Xu, Zhai & Rosenberg 2022 (arXiv:2209.08435) — 28-day positive-action objective, hides in real-time sequence; PinRec (arXiv:2504.10507) — outcome-conditioned retrieval (plausible class D mechanism); SEINE (arXiv:2207.10767) — follow-back ratio, shared IP/content, domain concentration; label pipeline (Pinterest Eng 2021) — batch labels within 24 h, streaming ~5 min, human review for trusted creators.

Implementation: guided (user-performed) search-visibility probe for top Pins; classifier features = breadth, age-stratified ratios, per-domain ratios, rate stability, same-URL/same-image repetition counts, save velocity, weather p-value, weekday of onset.

## 7. Agent-driven software engineering reliability

Papers: SWE-agent (NeurIPS 2024); AutoCodeRover (arXiv:2404.05427); MetaGPT (arXiv:2308.00352); Bjarnason, Silva & Monperrus 2026 "On Randomness in Agentic Evals" (arXiv:2602.07150); Reichmann et al. 2026 "Is Three the Magic Number?" (arXiv:2607.05197); Gao, Yang & Yang 2026 "Looping Is Not Reliability" (arXiv:2607.24604); Zheng et al. 2026 SWE-Bench Pro Verified (arXiv:2609.08149); Cursor blog on reward hacking (Jun 2026); Ralph loop (Huntley).

Findings: single-run pass@1 varies 2.2–6.0 points, σ 0.7–1.8, even at temperature 0; ~9 runs to detect a 2-point improvement; repair-loop gains mostly in first 3–4 iterations, ≈0 after 5–7; forced revision lost correct patches (0.820 → 0.673 currently correct); stale verifier traces harmed 34/135 starts; agents retrieved fixes from upstream PRs (57% of audited trajectories), mined .git (9%), read hidden tests; sealing history and egress cut scores 14–21 points; ACI design and test-based fault localisation drove resolution rates.

Implications: held-out golden tests outside the editable tree; cap iterations at 3–5; checkpoint on green; re-run flaky evals ≥ 3×; spec-first with testable criteria; sandbox with registry-only network; numeric tolerances in the held-out suite.

## 8. Alert design

Sources: Benjamini & Hochberg 1995; Johari et al. mSPRT; Page 1954 ARL; Elkan 2001 cost-sensitive learning; Google SRE monitoring chapter.

Rules: BH with q = 0.05 notify, 0.01 page; alert iff P(cliff|data) ≥ p* = C_FA/(C_FA + C_miss) (derived from Elkan); CUSUM h for ARL ≈ 1 false alarm per account-year; always-valid p-values for daily peeking; page on symptoms, every alert actionable, prune alerts that rarely fire. Tiers: Watch (z < −3.5, dashboard), Drop detected (two methods, effect ≥ 50%, q ≤ 0.05), Action needed (cause A/B/C ≥ p*, not platform-wide); one broadcast per platform event; log outcomes to re-estimate costs and p₀.

## Ranked pipeline

v1: ingest → STL on log1p → PELT (l2 + rank, min_size 7, BIC) + CUSUM → robust-z point anomalies (dashboard) → signature features → Beta-Binomial weather → rule classifier (D if weather fires; A if domain-wide and rates stable; E if top-1% share > 50% and breadth low or gradual; C if duplicate/same-URL spike and rates stable; B if rates fell) → BH tiers → held-out synthetic fixtures drive the loop.
v2: BOCPD; NB-GLR per Pin; CausalImpact "just me" score; Bardwell panel dating; mSPRT; cost-sensitive thresholds from feedback; probe confirmation layer.

## Sources

BOCPD https://arxiv.org/abs/0710.3742 · PELT https://arxiv.org/abs/1101.1438v3 · ruptures https://arxiv.org/abs/1801.00718 · robust BOCPD https://proceedings.neurips.cc/paper/2018/hash/a3f390d88e4c41f2747bfa2f1b5f87db-Abstract.html · CUSUM https://en.wikipedia.org/wiki/CUSUM · panel MRC https://arxiv.org/pdf/1609.06805 · S-H-ESD https://arxiv.org/abs/1704.07706 · STL https://rdrr.io/r/stats/stl.html · Prophet https://facebook.github.io/prophet/static/prophet_paper_20170113.pdf · NB-GLR https://cran.r-universe.dev/surveillance/doc/glrnb.pdf · CausalImpact https://arxiv.org/abs/1506.00356 · synthetic control https://www.mit.edu/~jhainm/Paper/ccs.pdf · mSPRT https://arxiv.org/abs/1512.04922v2 · CF-Shapley https://arxiv.org/pdf/2208.08399 · Cha et al. https://www.cl.cam.ac.uk/~jac22/camhor/mia_imc07_sumitted.pdf · power laws https://arxiv.org/abs/0706.1062 · Le Merrer https://arxiv.org/pdf/2012.05101 · TikTok audit https://arxiv.org/pdf/2607.17356 · Delmonaco https://deepblue.lib.umich.edu/handle/2027.42/192621 · PinSage https://ar5iv.labs.arxiv.org/html/1806.01973 · PinnerFormer https://arxiv.org/abs/2205.04507v1 · TransAct https://arxiv.org/pdf/2306.00248 · Xu et al. https://ar5iv.labs.arxiv.org/html/2209.08435 · PinRec https://arxiv.org/abs/2504.10507 · SEINE https://arxiv.org/pdf/2207.10767 · spam ML https://medium.com/pinterest-engineering/how-pinterest-fights-spam-using-machine-learning-d0ee2589f00a · label pipeline https://medium.com/pinterest-engineering/building-a-label-based-enforcement-pipeline-for-trust-safety-4b05a409cb5d · fresh Related Pins https://medium.com/@Pinterest_Engineering/6b0e2876d7e · per-Pin cliff https://community.pinterest.biz/t/i-measured-my-august-drop-per-pin-every-pin-older-than-7-days-lost-95-in-48-hours-new-pins-untouched/50281 · duplicate pins thread https://community.pinterest.biz/t/the-truth-about-duplicate-pins-why-your-impressions-dropped-to-zero/31189 · SWE-agent https://papers.neurips.cc/paper_files/paper/2024/hash/5a7c947568c1b1328ccc5230172e1e7c-Abstract-Conference.html · AutoCodeRover https://arxiv.org/abs/2404.05427v3 · MetaGPT https://arxiv.org/abs/2308.00352v5 · randomness https://arxiv.org/html/2602.07150v2 · three https://huggingface.co/papers/2607.05197.md · looping https://www.alphaxiv.org/abs/2607.24604 · SWE-Bench Pro Verified https://huggingface.co/papers/2609.08149.md · Cursor https://cursor.com/blog/reward-hacking-coding-benchmarks · Ralph https://ralph-wiggum-web.onrender.com/ · BH https://www.dcscience.net/Benjamini-Hochberg-1995-FDR.pdf · Elkan https://mlanthology.org/ijcai/2001/elkan2001ijcai-foundations · SRE https://sre.google/sre-book/monitoring-distributed-systems/

Caveats: Wald 1945 and Cleveland 1990 originals cited via secondary pages; no Pinterest paper discloses head weights or a "pin quality" feature; the age-stratified signature rests on one community post; no Python port of algo.glrnb found (~1 day to implement).
