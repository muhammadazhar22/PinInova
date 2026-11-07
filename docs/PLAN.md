# PinPulse — Production Master Plan (Agent-Driven Build)

Nov 7, 2026 · @Muhammad Azhar

## Executive summary

PinPulse is a Pinterest account health, diagnosis and protection service, built by one founder with agent-driven engineering, that answers the question Pinterest's own support staff say they cannot: "what happened to my account, and is it just me?" The thesis: creating and scheduling Pins is crowded (Tailwind, PinClicks, PinGenerator, 10+ AI tools); watching a Pin after it is published is empty. In 2026 creators report overnight 66–99% reach collapses clustered on shared dates (8 May, 18 Aug, 24–27 Sep), Pinterest's forum guide says moderators cannot tell whether an account is flagged or limited, and no product diagnoses drops. First buyer: Pinterest virtual assistants and small agencies managing 5–30 client accounts, who need an answer for the client before the client churns.

The plan commits to five decisions:

1. Sell explanation and protection, never a recovery promise. The product classifies a drop into one of five cause classes (enforcement, quality down-ranking, behavioural, platform incident, seasonality/decay) with a stated confidence, and tells the user what not to waste time on.
2. Compliance-first architecture. Pinterest's Developer Guidelines ban scraping, storing API data beyond need, combining users' account data, and unauthorized benchmarking. Every module is designed inside those lines; the cross-account "Pinterest weather" index ships only after written authorization or from user-reported data.
3. Modular monolith (TypeScript, Next.js) plus one Python analytics worker (changepoint detection, Bayesian tests). Postgres with time-partitioned tables, a rate-limit-aware job queue, and a 90-day rolling data window that matches the API's own lookback.
4. Agent-driven build with loop engineering: spec → task → implement → test → review → merge, run by Claude Code agents under CI quality gates, with the founder owning specs, reviews and anything irreversible. Detectors are developed against synthetic series with known ground truth, so the loop has an objective score to climb.
5. Staged release with kill criteria. v0 free "Pinterest Drop Check" lead magnet (4 weeks), v1 paid health scan + link integrity + appeal evidence pack for VAs (12 weeks), v2 agency mode + GA4 traffic-leak check (6 months), v3 weather index + Shopify revenue join (9–12 months).

12-month target: 150 paying workspaces at a blended $39 per workspace per month (about $6k MRR, $70k ARR; a workspace holds 1–20 accounts), API Standard access, one authorization conversation with Pinterest underway, infrastructure cost under $400/month, and a detector eval that beats the naive 50%-drop rule a VA applies by hand (onset F1 0.82 vs 0.29 on the synthetic benchmark). The founder should decide now whether a $70k-ARR year-one outcome is the goal or a stepping stone; the plan is sized for a tool that can become a company, not for venture scale in year one.

Hard constraints the whole plan obeys: Pinterest API v5 gives 90 days of daily metrics and no distribution-status fields; Trial tier is 1,000 requests/day and sandbox only; Standard tier requires app review; Stripe is unavailable in Pakistan (Paddle or Lemon Squeezy as merchant of record); one engineer, so every subsystem must be runnable and debuggable by one person with agents.

Source basis: the project's prior research (136-item evidence log, 4 Nov reach-drops deep dive, 7 Nov attribution evaluation) plus the four research streams in this document (academic methods, Pinterest platform facts, competitor and customer research, engineering stack), all cited in Sources.

## 1. Product research synthesis

The problem is real, widely reported, and unserved; the uncertainty is willingness to pay and whether VAs lose clients over it. The prior evidence log (136 items, Oct–Nov 2026) ranks reach collapse first by opportunity score, and the Pinterest Business Community now carries a pinned staff guide for impression drops that explicitly says staff cannot diagnose accounts.

| Problem | Evidence items | What users ask for | Served today? |
| --- | --- | --- | --- |
| P1 Reach collapse / zero impressions | 26 | "Am I flagged?" "Is it just me?" "Which date did it start?" | No tool diagnoses; Tailwind publishes advice only |
| P2 Opaque spam suspensions and bans | 19 | Why, and how to appeal with evidence | Appeal templates in blogs; no evidence tooling |
| P3 Visit-site button removed / domain blocked | 13 | Which landing-page check failed | PinClicks Pin Plus alerts only ($49/mo tier) |
| P6 Cannot diagnose the cause | 17 | Yes/no on flags, claim status, peer comparison | Nothing |
| P5 Stolen pins / content theft | 14 | Detection + DMCA | Manual; detection would need scraping (policy risk) |

Five recurring signatures in creator reports make automated diagnosis plausible: (1) new Pins at 0–1 impressions while old Pins perform; (2) linked Pins at zero while unlinked Pins perform; (3) impressions collapse while engagement per impression stays flat (distribution cut, not content decay); (4) shared onset dates across many niches (platform-side cause); (5) one viral Pin fading inside a heavy-tailed account (normal decay that looks like a cliff; Tailwind says the top 1% of Pins drive over 50% of impressions).

### Personas (jobs-to-be-done)

| Persona | Job to be done | Trigger | Objection | Pay signal |
| --- | --- | --- | --- | --- |
| Pinterest VA / small agency (5–30 client accounts) | Explain a drop to a client within 24 hours with evidence; prove it was not the VA's work | Client message: "traffic halved, what did you do?" | Clients must connect their own accounts; price per account adds up | Pays Tailwind $12–30 per account already; retainer $300–$1,500/client/month (verified: DDIY Feb 2026, Boutique COO, Larsen course page) |
| Blogger / affiliate creator | Know whether to keep publishing or change strategy; file one good ticket | Impressions fall 60–90% overnight | Budget; tool fatigue | Pays PinClicks $29–49; many pay nothing |
| Shopify / Etsy merchant | Confirm Pinterest still sends sales; find link/landing-page problems | Sales from Pinterest stop; Visit-site button gone | Low Pinterest priority vs Meta/Google | Lowest; defer to v2 |

The research streams in this document closed two of three gaps: competitor pricing and features are now verified (section 12), and VA economics are documented; quantified search volume was not retrievable. The prior research found no first-hand report of a VA losing a client over a drop; that is the single most important thing to validate in interviews before v1 pricing is fixed.

### Competitive map (prior research; stream 3 updates it below)

| Category | Players | Post-publish monitoring | Position vs PinPulse |
| --- | --- | --- | --- |
| Schedulers | Tailwind, Planoly, Later, Buffer, Metricool | Basic analytics, no drop diagnosis | Partners, not competitors; PinPulse sits alongside |
| AI pin generators | PinGenerator, BlogToPin, Outfy, 10+ indie tools | None | Irrelevant to the health job |
| Research / keyword | PinClicks, Pin Inspector, Pinterest Trends | PinClicks Pin Plus: AI-label and Visit-site alerts | Closest partial competitor; opaque methods |
| "Shadowban checkers" | Circleboom, PostEverywhere | Opaque or no Pinterest support | Credibility gap PinPulse exploits with transparent evidence |

## 2. Platform constraints (verified 7 Nov 2026)

Pinterest's API gives enough to build the health scan, and its Developer Terms (last updated August 2026) decide what PinPulse may keep, pool and automate. Facts below come from the official OpenAPI spec (v5.28.0), developers.pinterest.com, policy.pinterest.com and the Business Community; quoted fragments are verbatim.

### API v5 facts that shape the design

| Fact | Value | Design consequence |
| --- | --- | --- |
| Analytics lookback | `start_date` "Cannot be more than 90 days back from today" on account, top-Pin and Pin analytics | Daily snapshots from day one; CSV import (native Analytics exports 1.5 years) is the only backfill |
| Account analytics splits | `split_field` NO\_SPLIT, APP\_TYPE, OWNED\_CONTENT, SOURCE, PIN\_FORMAT; `content_type` PAID/ORGANIC; `from_claimed_content` | Owned-vs-other and organic-only series are available natively; no search-vs-home-feed split |
| Per-Pin analytics | `GET /pins/{id}/analytics` daily metrics; bulk `GET /pins/analytics` is beta (100 Pins/call); `GET /pins?pin_metrics=true` returns 90d and lifetime per Pin | Track about 300 Pins per account (top 50 + active set + weekly long tail) |
| Board analytics | No endpoint | Aggregate from Pin metrics |
| Webhooks | Lead-ads only | Scheduled polling |
| Domain claim | `GET /user_account/websites` returns `status`, `verified_at` | Claim check is API-native |
| Data lag | About 48 h observed for organic data (community, June 2026); `date_availability.latest_available_timestamp` on top\_pins | Treat the last 2 days as provisional; show "data through" dates |
| Access tokens | 30 days; continuous refresh token 60 days, rotated on each refresh | Refresh job every 20 days; alert at 50 days without refresh |
| Rate limits | Trial: 1,000 requests/day/app, sandbox only. Standard: `org_analytics` 60/min/user/app; `org_read` 1,000/min/user/app | Per-user token buckets; Trial is a fixture-recording budget, not a product tier |
| Standard access | Video of the OAuth flow and a live integration required; community threads show 2–4+ week backlogs and unexplained denials (Aug–Oct 2026) | Apply in week 2; budget 4–8 weeks |
| Apps registered on/after 14 Sep 2026 | 403 `PINNER_DATA_ACCESS_DENIED` when reading Pins or boards not owned by the authorizing account | No competitor-Pin features; read only the connected account |
| AI disclosure | `ai_disclosures` enum AI\_MODIFIED, SYNTHETIC\_PERFORMER on Pins | Pre-flight check can read the user's own declared labels |

### Developer Terms and Guidelines: the clauses that bind

| Topic | Clause (verbatim fragment) | PinPulse rule |
| --- | --- | --- |
| Storage | "you may not store any information accessed through any Pinterest Materials"; exception in Terms §4.1(a) for "campaign analytics information" about accounts the holder "has expressly granted you access" | Store numbers only (metrics), never Pin content or images; get written consent email that organic analytics snapshots qualify |
| Combining | "Don't combine someone's account information with information from other people's accounts" | Strict per-tenant isolation; no cross-tenant models; weather index gated |
| Benchmarking | No "platform insights, benchmarking, or competitor research features" without "explicit written authorization from Pinterest (email is sufficient)" | Compare an account only to its own history until authorized |
| Scraping | No "automated means or form of scraping or data extraction" | No logged-out search probes by the system; visibility checks are guided, user-performed steps |
| Deletion | Terms §4.4: delete Pinterest Data "in no event later than thirty (30) days" after revoke, churn or account deletion; certification within 10 business days on request | Automated purge within 24 h of disconnect; deletion log and certification export |
| PII | "You will not join any Pinterest Data with personally identifiable information" | Shopify join uses order UTMs and amounts, never customer identity |
| Actions | No actions "without their specific knowledge and consent"; no features that "automatically initiate actions" | Read scopes only in v1; any future fix is one Pin, one confirmation |
| Review | Submit "for review and approval prior to distribution"; material changes need re-review | Version the feature set; notify Pinterest on scope changes |
| Intermediary tools | Terms now name "Model Context Protocol (MCP) servers, wrappers, plugins, middleware, agents" | A PinPulse MCP server is covered by the same review |

### Policy changes on 12 Nov 2026

The Community Guidelines preview adds a "Scams, deceptive goods, and practices" section (engagement manipulation "through automated, paid, or incentivized means"; synthetic media that misrepresents products), extends the repetitive-content rule to "distribute", and adds a catch-all against tactics that "improperly influence distribution, clicks, or other metrics". The explicit "redirect existing Pins" line is dropped but the "no surprises" link rule remains. Affiliate links are not mentioned in either version. The Enforcement page keeps "Limited distribution" and "shown less often or less prominently" as non-violation outcomes, and caps appeals per person and per decision.

### Compliance architecture (one sentence each)

1. The analytics service receives one user's series at a time and never sees tokens or other tenants.
2. Raw metrics live in a 90-day rolling partition; derived outputs (changepoints, cause labels, reports) are per-tenant and purged on disconnect.
3. Row-level security keys every table by workspace; agency users see clients through membership joins, never through cross-client queries.
4. The weather index is a separate module fed by user-reported onsets and forum counts until Pinterest authorizes pooled metrics in writing.
5. Every outbound Pinterest call goes through one client with per-user buckets, header-driven throttling and fixture recording.
6. Dated copies of the Terms, Guidelines and Enforcement pages are stored in `docs/policy/` with a re-read reminder on each Pinterest changelog entry.

Questions already drafted for Pinterest developer support: scope of the analytics storage exception for organic metrics; whether comparing to Pinterest-published thresholds counts as benchmarking; official data lag; access to beta bulk analytics; whether Business Access by an agency satisfies "expressly granted"; exact ad auto-UTM values; whether any field exposes limited-distribution state.

## 3. Product definition

PinPulse ships as four releases, each with a single sentence a VA can repeat to a client, and each gated by a measurable result from the one before.

| Release | Promise to the user | Modules | Gate to proceed |
| --- | --- | --- | --- |
| v0 Drop Check (free, weeks 1–4) | "Paste your CSV export; we tell you the date it broke, which Pins drove it, and whether the pattern looks like a distribution cut." | CSV changepoint + top-Pin decomposition; signature report; email capture | 300 reports run, 25 interview bookings, 10 concierge audits sold at $49 |
| v1 Health (paid, weeks 5–16) | "Connect Pinterest; we watch every account daily, flag a suspected cliff within 3 days and confirm it with a cause within 7–9 days, and build the appeal evidence pack." (Latency is derived from the pipeline: about 2 days of API data lag, a 1-day online CUSUM warning, then a 5–7 day confirmation segment for the two-method changepoint and the rate test.) | OAuth sync; health scan and alerts; cause classifier; link and domain integrity; pre-flight checks; appeal evidence pack; client PDF report | 30 paying workspaces, Standard API access, alert precision above 80% on labelled cases |
| v2 Agency (months 5–6) | "Every client account in one place, each with its own consent, and a monthly report your client can read." | Multi-client workspaces with isolated consent; roles; white-label PDF; GA4 Traffic Leak Check; Slack alerts | 100 workspaces; 3+ agencies with 10+ accounts |
| v3 Weather + Revenue (months 7–12) | "See whether a drop hit everyone on that date, and what Pinterest is worth in orders." | Pinterest weather index (authorized or user-reported); Shopify order join via per-Pin utm\_content tokens; theft defense only if demand validated | Written authorization or 500 consenting reporters; 150 workspaces |

### Module definitions

1. Health scan and alerts. Daily account and per-Pin metrics over a 90-day rolling window; changepoint detection on impressions, outbound clicks and saves; decomposition into new-vs-old Pins, linked-vs-unlinked, owned-vs-other content; alerts with a cause class and confidence.
2. Cause classifier. Five classes (A enforcement, B quality down-ranking, C behavioural/ranking, D platform incident, E demand and decay) plus one measurement artifact (GA4 "Direct" misattribution). Output is a ranked list with evidence, never a single verdict.
3. Link and domain integrity. Fetch the user's own landing pages as Pinterestbot, check HTTP status, redirect and shortener chains, robots.txt and Crawl-delay, load time under 4 s, content match, claimed-domain status via the API, and URL drift on existing Pins. Lowest policy risk, strongest compliant differentiator.
4. Pre-flight compliance check. Rules engine over draft Pins: duplicate image or URL rate, same-URL spacing, volume spikes, bulk-upload and "#ad" prefix patterns, keyword stuffing, AI-metadata presence in tuner niches. Each rule labelled official, vendor or hypothesis; rules re-read after the 12 Nov 2026 Community Guidelines update.
5. Appeal copilot. Generates a dated evidence pack (timeline, matched-pair results, domain checks, screenshots the user takes) for the "creator stats drop" ticket. Makes no outcome promise; reminds users that appeals are capped per year.
6. Client report. Monthly PDF with health score trend, incidents, cause classes, actions taken, and a plain-language summary a client can read.
7. Agency mode. Workspaces, per-client OAuth consent, roles, and no cross-client ranking (which may count as combining account data).
8. Pinterest weather index. Fraction of monitored accounts showing a changepoint in a shared window. Built from user-reported onset data and forum thread counts first; API-pooled only with written authorization.
9. Traffic Leak Check and revenue join. GA4 Pinterest-vs-Direct gap detection; per-Pin utm\_content tokens on new Pins joined to Shopify order UTMs. Board revenue only as a sum of tagged Pins.

### Non-goals

- No Pin creation, scheduling or AI image generation (crowded; partners do it).
- No scraping of Pinterest surfaces, no logged-out search checks, no automated Visit-site button detection.
- No "recovery guarantee" and no "shadowban score" without visible evidence.
- No organic keyword revenue (Pinterest exposes no query data) and no Etsy order attribution (no source data in Etsy's API).
- No cross-client benchmarking inside agency mode until authorized.

## 4. Detection and diagnosis science

The engine is a pipeline of five statistical questions, each answered by a method with published grounding, and each with a v1 (deterministic, pure Python, shipped first) and a v2 (Bayesian, once labels exist). The data regime is 90 daily points per account, weekly seasonality, counts from single digits (per Pin) to millions (large accounts), and cliffs of 50–99%. A running reference implementation with a synthetic benchmark is in the seeded repo (`services/analytics`).

### Q1. When did the level change? (changepoint detection)

v1 uses PELT (Killick, Fearnhead & Eckley 2012) on log1p counts after STL deseasonalisation (period 7, robust). The objective is

```latex
\min_{\tau_1<\dots<\tau_m} \sum_{i=1}^{m+1} \mathcal{C}(y_{\tau_{i-1}+1:\tau_i}) + \beta m, \qquad \mathcal{C}(y_{a:b}) = \sum_{t=a}^{b} (y_t - \bar{y}_{a:b})^2
```

with recursion F(s) = min\_t { F(t) + C(y\_{t+1:s}) + β } and pruning of any t where F(t) + C(y\_{t+1:s}) ≥ F(s). Penalty β = σ̂² log T (BIC form), σ̂ from 1.4826 × MAD of first differences so a cliff does not inflate its own threshold; minimum segment 7 days. Complexity O(T²) worst case, trivial at T = 90. A rank-cost run (`ruptures` model="rank") is the robustness check; a changepoint is accepted only if both agree within ±2 days. The online daily check is a one-sided CUSUM on the log scale with k = log(2)/2 (target: a 50% drop) and threshold h calibrated to one false alarm per account-year on simulated noise.

v2 replaces PELT with Bayesian Online Changepoint Detection (Adams & MacKay 2007), run-length posterior P(r\_t | x\_{1:t}) with hazard 1/λ, λ ≈ 60–90, reporting P(r\_t < 7) as "probability a change occurred this week". The β-divergence robust variant (Knoblauch, Jewson & Damoulas 2018) is the fallback if viral spikes cause false alarms. Per-Pin and small-account series use a negative-binomial GLR chart with weekly Fourier terms (Höhle & Paul 2008), which handles small counts and overdispersion and is itself a sequential drop detector.

### Q2. Is it a distribution cut or a content problem? (rate stability)

If impressions collapse but clicks per impression and saves per impression do not move, the ranking model still values what it shows; distribution was cut upstream (classes A, C, D). Pre window (τ−28..τ−1) and post window (τ..τ+6) are compared with a Beta-Binomial model; the log Bayes factor for "two rates" vs "one rate" is

```latex
\log BF = \log \frac{B(\alpha+k_1,\beta+n_1-k_1)\,B(\alpha+k_2,\beta+n_2-k_2)}{B(\alpha,\beta)\,B(\alpha+k_1+k_2,\beta+n_1+n_2-k_1-k_2)}
```

with clicks k over impressions n. The verdict is shown only after 500 post-cliff impressions. For daily re-evaluation without inflating false alarms, v2 uses the mixture SPRT with always-valid p-values (Johari, Pekelis & Walsh 2015).

### Q3. Which Pins drove the drop, and is it one viral Pin fading? (decomposition)

Impressions are additive, so an account change decomposes exactly: ΔY = Σ\_p (y\_p^after − y\_p^before), and the Shapley value of a Pin in an additive metric is its own Δ. The engine reports cumulative share ("3 Pins explain 82% of the drop"), pre-cliff concentration (top-1% share, Gini; Tailwind says the top 1% of Pins drive over 50% of impressions) and breadth (fraction of Pins with ≥10 impressions/day that fell ≥80%). Age-stratified drop ratios (0–7, 8–14, 15–29, 30+ days since publish) come from a community measurement of the August 2026 cliff: every Pin older than 7 days lost about 95% within 48 hours while fresh Pins were untouched, which matches Pinterest's own description of a separate fresh-Pin candidate path. High breadth plus age stratification signals a retrieval-side cut; low breadth plus a top-heavy account signals class E decay. For ratio metrics (account CTR) the rate/mix decomposition applies; counterfactual Shapley (Sharma, Li & Jiao 2022) is reserved for a "why did CTR change" view.

### Q4. Is it just me? (platform-wide attribution)

v1 is a cluster test: of n monitored accounts active on day d, k have a changepoint onset within ±2 days. Under no platform event, k \~ Binomial(n, p₀) with p₀ the background cliff rate per 5-day window (about 0.0017 if 3% of accounts cliff per quarter). Because accounts share niches and shocks, the test uses a Beta-Binomial with precision φ fitted from the historical distribution of k/n:

```latex
\log BF_{\text{weather}} = \log \frac{B(a+k,\,b+n-k)}{B(a,b)} - \big[k\log p_0 + (n-k)\log(1-p_0)\big]
```

"Platform-wide" is declared at tail probability below 0.001 and k/n ≥ 10%, stratified by niche and account size. With n = 50 and p₀ = 0.0017, three simultaneous cliffs already have binomial probability near 10⁻⁴, which is why the overdispersion correction matters. v2 adds CausalImpact (Brodersen et al. 2015): a Bayesian structural time-series model with a local level, weekly seasonality and the leave-one-out pooled index as the control, whose posterior for the unexplained residual drop is the "just me" score. The Bardwell et al. (2017) panel most-recent-changepoint model dates platform events precisely. Until Pinterest authorizes pooled metrics, the index runs on user-reported onset dates and Business Community thread counts by date.

### Q5. What should we tell the user, and when? (classification and alerting)

v1 cause classification is rule-scored with a softmax to confidences: D if the weather test fires; A if the drop is domain-wide (Pinterest applies "the same enforcement to all Pins with links belonging to the same domain") and rates are stable; C if duplicate-URL or bulk-upload patterns rose in the prior 14 days and rates are stable; B if rates fell with impressions or Visit-site was demoted; E if one or two Pins explain most of the drop or the decline is gradual and matches last year's curve; M if GA4 Direct rose as Pinterest referrals fell. v2 fits a logistic model on the same features once user-labelled outcomes accumulate. Alerts control false discovery across accounts with Benjamini–Hochberg (q = 0.05 notify, 0.01 push) and use a cost-sensitive threshold p\* = C\_FA / (C\_FA + C\_miss) exposed as a sensitivity slider. Tiers: Watch (dashboard only), Drop detected (changepoint confirmed by two methods, effect ≥ 50%), Action needed (cause A/B/C above p\* and not platform-wide). A platform-wide event produces one broadcast, not n alerts.

### Benchmark and loop target

The seeded repo generates 300 synthetic accounts (negative-binomial daily impressions with weekly seasonality, trend, 80% containing a labelled cliff across the five classes) and scores onset F1 within ±2 days, class accuracy and false-alarm rate: score = 0.4 F1 + 0.4 accuracy + 0.2 (1 − FAR). Honest baseline after the independent review removed label leakage from the generator (side signals are now noisy and incomplete, and the peer signal is absent in v1): onset F1 0.82, class accuracy 0.64, false alarms 0.09, mean onset delay 0.03 days, score 0.77; the naive hand rule scores onset F1 0.29. Per-class accuracy is uneven by design: D 0.76, B 0.74, C 0.38, A 0.31 (A versus D is structurally ambiguous without per-domain breadth or peer data), E 0.00 (a smooth fade is not a step; the first loop hypothesis is a fade-shape detector). The benchmark now also reports detection delay, a confusion matrix and the naive-rule comparison; CI enforces an absolute floor of 0.6 and forbids changing the baseline in the same PR as detector code; a no-lookahead test truncates series and asserts earlier verdicts do not change. The benchmark is frozen; the agent loop may only change `detectors.py`, and CI fails any regression beyond 0.01. Real labels replace synthetic ones as concierge audits and user feedback accumulate.

### What the audit literature warns

Deterministic probes beat inference: Le Merrer et al. (2021) proved Twitter shadowbans with black-box visibility tests and no false positives, so PinPulse guides users through their own search-visibility check rather than inferring it. Ibrahim & Girmay (2026) show pooled Pin-day observations inflate significance by a design effect near 180; the account is the unit of inference and tests are cluster-robust. Pinterest's published ranking work (PinSage, TransAct, PinRec) confirms hides are an explicit negative head, saves and clicks are positives, retrieval is outcome-conditioned (a plausible class D mechanism), and models retrain about twice weekly, so platform steps can land on specific weekdays.

### Graph engineering: verdict

Graph engineering is not required as infrastructure, is useful as a modelling lens, and a graph database is not justified at v1 or v2. Pinterest's own distribution and enforcement systems are graph-driven, so thinking in graphs tells PinPulse which signals to compute; but inside one account's data (at most about 5,000 Pins, a few hundred boards, tens of domains) every graph that can legally be built is tiny, shallow (one or two hops) and star-shaped, and Postgres joins plus about fifty lines of numpy or NetworkX cover it.

| Part | Graph needed? | What to build |
| --- | --- | --- |
| Cause A, domain enforcement | Graph concept only (Pin → domain star); Pinterest's spam system scores domains by label propagation on a user–domain bipartite graph and applies "the same enforcement to all Pins with links belonging to the same domain" | `GROUP BY domain` drop ratios in SQL, with public-suffix normalisation so subdomains group correctly |
| Cause B, quality down-ranking | No | Age-cohort window functions |
| Cause C, behavioural | Yes, small: near-duplicate image clustering is a real graph problem | Perceptual hash per image (imagehash pHash 64-bit, Hamming ≤ 6–10, or Meta's PDQ ≤ 30/256) → vectorised pairwise Hamming (12.5M comparisons at 5,000 Pins, under a second) → union-find connected components; plus same-URL repetition with `LAG(created_at)` gaps and Pins-per-day burst z-scores |
| Cause D, platform incident | Would need a cross-account graph: policy-blocked | User-reported onsets, forum counts, the founder's own canary accounts; pooled metrics only with written authorization |
| Cause E, decay | No | Per-Pin cohort time series |
| Classifier | Not a graph store; a hand-specified causal DAG is a reasonable v2 | v1 rule scores + logistic regression; v2 knowledge-informed Bayesian network (pgmpy) once a few hundred labelled cases exist |
| Cross-account "related accounts hit together" | Technically valuable (Le Merrer et al. 2021 found banned accounts cluster in the interaction graph; SEINE finds shared IP, content and domain neighbours predict enforcement) but forbidden on user data without authorization | Not built; agency views must not link clients by shared domain, IP or template |

What Pinterest's graph papers expose as creator-side levers, all computable from one account: board placement and topical coherence (Pixie prunes high-entropy boards and mis-categorised Pin–board edges, and smaller focused boards walk better); saves from others (each save is a new Pin–board edge in PinSage's neighbourhood); domain concentration (SEINE uses the proportion of a user's interactions with each domain as an edge feature); and duplicate image signatures (Pinterest's near-duplicate system collapses clusters to one canonical Pin and filters the rest from feeds and search, so re-posting one image to many boards or URLs starves the copies).

The root-cause-analysis literature settles the classifier question: learned causal discovery (PC, GES, LiNGAM) performed about as well as random picks in a 2024 ASE study of 21 methods, while knowledge-informed structure (Alibaba's CloudRCA lost 0.1–0.2 F1 without predefined knowledge; Microsoft's CIRCA uses an architecture-derived DAG) and simple statistical baselines were the strongest. PinPulse therefore hand-draws its DAG and never tries to learn one from 90-day series. Tooling reviewed and set aside: Neo4j (GPL/commercial split), Memgraph (BSL), Kuzu (archived after Apple's acquisition; LadybugDB is the maintained fork), Apache AGE 1.8 and DuckPGQ (fine for notebooks, not production), PyG (needs many labelled graphs). Two policy flags recorded: a perceptual hash is derived, non-reversible data but still "information" under a strict reading of the storage clause, so hashes are computed transiently and only cluster membership is persisted until Pinterest answers in writing; and duplicate-cluster views show Pin ids and links, never re-hosted images.

## 5. Product design

The brand stance is calm, forensic and independent: the market's tone is either panic ("read this before you spiral") or denial ("shadowbanning is a myth"), and PinPulse is the clinician who shows evidence, a confidence level and the next action. The vocabulary is Pinterest's own: "Limited distribution", "shown less often", "link-quality demotion", "spam-filter false positive". The word "shadowban" appears only on the SEO landing page that reframes it.

### Design principles

1. Every verdict shows its evidence. A cause card is never a bare label; it lists the factors that scored, the way Stripe Radar lists risk insights.
2. Separate whose fault it is. Each issue carries a Source chip (Pinterest / You / Unknown), the way Google Search Console separates site issues from Google-side ones; only "You" issues get a fix button.
3. Group noise into issues. Twenty Pins that lost the Visit-site button on 3 Nov are one issue with a count, Sentry-style, with Regressed and Escalating states.
4. Close the loop. A fix has a "Validate" state over 2–4 weeks (Started, Looking good, Passed, Failed), so the user learns whether the action mattered.
5. One number, published formula. Health score = share of active Pins, boards and domain checks with no error-level signal, in four bands (Weak 0–30, Fair 31–70, Good 71–90, Excellent 91–100), with per-client suppression of known false positives (Ahrefs model).
6. Reports are the product for VAs. The monthly report is designed before the dashboard, because it is what justifies the retainer.

### Information architecture

| Area | Screens | Primary user |
| --- | --- | --- |
| Workspace home | Client switcher; health score per client; open issues; weather strip | VA / agency |
| Account overview | Annotated timeline (impressions, outbound clicks, saves) with changepoint markers and event annotations; sub-grades: Distribution, Link quality, Content integrity, Domain trust, Cadence | All |
| Incident | Cause card(s) ranked by confidence; evidence list; Pin decomposition; age-stratified view; linked-vs-unlinked view; rate-stability verdict; "is it just me" panel; actions and Validate state | All |
| Issues | Grouped issues with Source chip, count, first seen, state; thematic tabs: Distribution, Link quality, AI labels, Domain integrity, Cadence/spam risk | VA |
| Checks | Domain integrity checklist (claim, robots.txt, Pinterestbot access, redirects, load time, content match, Safe Browsing); pre-flight rules; matched-pair wizard; guided search-visibility check | VA, blogger |
| Reports | Report builder; monthly PDF; evidence pack for the creator-stats-drop ticket; share link; white-label on Agency | VA / agency |
| Alerts | Rule editor (sensitivity slider mapped to p\*), channels (email, Slack), digest cadence | All |
| Settings | Connections and consent per client, retention, data export and deletion, billing | Owner |

### Key screens

1. Annotated timeline. ECharts line with markLine at each confirmed changepoint, markArea for the alert window, grey band for the account's own prior-year window when imported, and annotation pins for user actions ("switched to bulk upload", "new template") entered by the user. Legend toggles new-vs-old Pins and linked-vs-unlinked overlays.
2. Cause card. Title ("Distribution cut, likely platform-wide"), confidence 78%, Source chip, top three factors with their numbers, "Show all evidence", recommended action, "What not to do" (do not mass-delete, do not file five appeals), Validate button.
3. Matched-pair wizard. Four steps: pick two near-identical Pins differing in one variable (link / no link, AI label / none, board A / B), compare impressions and CTR over the same window, bootstrap significance, export to the evidence pack.
4. Domain integrity checklist. One row per check with Pass / Fail / Unknown, the exact Pinterest rule it maps to, and a fix link. Runs against the user's own site only.
5. Report builder. Cover with score and delta, timeline with annotations, "what happened / what we did / what is next", cohort note ("other accounts in Food showed the same onset" once authorized), appendix evidence pack; Loom script mode for VAs who report by video.
6. Empty, loading, error and no-data (under 14 days) states are specified for every screen; no screen may show a score before 14 days of data.

### Design system

- Typography: Inter (UI, tabular numerals on every metric), 16 px body, 14 px minimum in tables; the score numeral in a geometric display face.
- Colour: Radix 12-step scales; primary Teal or Indigo (trust, not alarm); status Green / Amber / Red / Grey with icons and text, never colour alone (WCAG 1.4.1); body text 4.5:1, UI components and chart series 3:1 (WCAG 2.2 1.4.3 and 1.4.11); Pinterest red avoided as a primary. Charts use one focus hue plus greys (Datawrapper guidance), at most five categorical hues, sequential scales only for ordered data such as the weather heatmap; tested for deuteranopia.
- Dark mode: token-based via Radix dark scales and shadcn `.dark`, with desaturated solids.
- Components: shadcn/ui (Radix primitives) + Tailwind v4; ECharts for the timeline; Recharts sparklines in cards; Tremor Tracker and ProgressCircle for the weather strip and score ring. The report shares the same React components rendered by Chromium so PDF and dashboard match.
- Component inventory: HealthScoreRing, AnnotatedTimeline, CauseCard, IssueList, ActionCenter, WeatherStrip and WeatherMap, MatchedPairWizard, DomainIntegrityChecklist, PreflightPanel, ReportBuilder, AlertRuleEditor, ClientSwitcher, ConsentBanner, DataDeletionDialog.
- Accessibility: keyboard paths for every wizard, ARIA live regions for scan progress, chart data tables behind every chart, reduced-motion respected.

The design artboards for the six key screens are the next design deliverable (a Design artifact), produced after the v0 interviews so the cause-card language is tested with real VAs first.

## 6. Architecture

The chosen shape is a modular monolith in TypeScript (Next.js) with one Node worker process sharing its code, one stateless Python analytics service, and Postgres as the only stateful system. Three approaches were weighed before choosing.

| Approach | Strength | Why not |
| --- | --- | --- |
| A. Single Next.js monolith on serverless (Route Handlers, Vercel cron) | One deploy, one type system | Serverless time limits break multi-hour nightly sync, Chromium PDFs and long-lived rate-limit schedulers; statistics would be ported to TypeScript |
| B. Microservices (Next.js + Hono API + Python + separate queue service) | Clean boundaries, independent scaling | Three to four codebases for one founder; duplicated auth and billing logic; more surface for agents to break |
| C. Modular monolith + Node worker + Python analytics (chosen) | Product logic once; long jobs on a VPS; statistics in Python where `ruptures`, `statsmodels` live; the stats service never touches tokens or the database | Three runtimes to deploy, two of which share code; mitigated by one compose file and one CI |

A fourth, deliberately rejected: an event-sourced or streaming architecture (Kafka, ClickHouse). The data arrives once a day per account, 90 days deep, numbers only; there is nothing to stream and no cross-tenant analytics allowed.

&#91;embedded content: system architecture · 7 components, 1 stateful\]

The analytics service receives one tenant's series and returns changepoints and cause features; it holds no state, which keeps the Pinterest compliance surface inside the worker and the database.

### Modules (apps/web/src/modules)

| Module | Responsibility | Public surface |
| --- | --- | --- |
| `auth` | Better Auth with organization plugin; roles owner / member / client-viewer | `getSession`, `requireOrg` |
| `pinterest` | OAuth connect, token vault (AES-256-GCM envelope, KEK versions), typed v5 client with per-user buckets, fixture recorder | `connect`, `disconnect`, `client(connectionId)` |
| `sync` | Nightly plan, tracked-Pin policy, resumable per-account jobs, late-data re-pull (last 3 days upserted) | `planNight`, `syncAccount` |
| `health` | Calls analytics service, stores incidents, issues, cause labels, health score | `scoreAccount`, `listIssues` |
| `integrity` | Pinterestbot-UA fetches of the user's own URLs, redirect chains, robots.txt, load time, claim status | `runChecks` |
| `preflight` | Rules engine over draft Pins; rules tagged official / vendor / hypothesis with policy dates | `evaluate` |
| `alerts` | BH-adjusted tiers, cost-sensitive threshold, channels, digests, broadcast for platform-wide | `evaluateAlerts`, `deliver` |
| `reports` | Report model, Chromium render, evidence pack, share links | `buildMonthly`, `buildEvidencePack` |
| `workspaces` | Agency → workspace → account; per-workspace consent records; audit log | `createWorkspace`, `recordConsent` |
| `billing` | Paddle webhooks, plan limits (accounts, tracked Pins), entitlement checks | `entitlements` |
| `privacy` | Disconnect purge, subject erasure, certification export, retention config | `purgeConnection`, `eraseSubject` |

### Data model (core tables)

| Table | Key columns | Notes |
| --- | --- | --- |
| `org`, `workspace`, `membership` | ids, role | RLS on `workspace_id` via `current_setting('app.workspace_id')` |
| `pinterest_connection` | workspace\_id, pinterest\_user\_id, scopes, ciphertext, iv, tag, kek\_version, refreshed\_at, status | Never in Better Auth's account table |
| `account_metrics_daily` | connection\_id, date, split (none/owned/source/format), impressions, saves, pin\_clicks, outbound\_clicks | Partitioned by month; 90-day retention for raw |
| `pin_metrics_daily` | connection\_id, pin\_id, date, impressions, saves, pin\_clicks, outbound\_clicks | Partitioned by week; `DROP PARTITION` retention; about 300 tracked Pins/account |
| `pin_meta` | connection\_id, pin\_id, created\_at, board\_id, link, domain, has\_link, declared\_ai | Numbers and URLs only; no titles, descriptions or images persisted |
| `incident` | connection\_id, onset\_date, effect, method\_agreement, rate\_bf, breadth, top1\_share, cause\_scores jsonb, state | Derived; kept 13 months; purged on disconnect |
| `issue` | connection\_id, kind, source (pinterest/you/unknown), count, first\_seen, last\_seen, state | Grouped like Sentry |
| `check_result` | connection\_id, url, hop\_chain jsonb, status, ttfb\_ms, robots\_ok, claim\_status, checked\_at | Integrity module |
| `weather_report` | reporter\_id (hashed), niche, onset\_date, symptoms | User-reported only until authorized |
| `alert`, `alert_feedback` | incident\_id, tier, channel, delivered\_at, useful (bool) | Feedback drives p\* and p₀ |
| `audit_event` | org\_id, workspace\_id, actor, action, target, before/after jsonb, at | Append-only |
| `agent_run` | task\_id, model, turns, cost, ci\_first\_pass, merged, reverted\_14d | Loop metrics (section 10) |

### Job scheduling and rate-limit mathematics

Standard-tier limits are per user per app: `org_analytics` 60 calls per minute for each connected account, independently. Per account per night: 1 account-analytics call (90-day window in one request, four split variants = 4 calls), 1 top-Pins call, ⌈P/250⌉ Pin-list calls (`org_read`, never the bottleneck) and T per-Pin analytics calls. With T tracked Pins the account takes about T/60 minutes: T = 50 takes 1 minute, T = 300 takes 5 minutes, T = 1,000 takes 17 minutes. For N accounts with C concurrent account streams at 1 call per second each, wall time is

```latex
W \approx \frac{N \cdot (T + 6)}{3600\, C} \text{ hours}
```

so 10,000 accounts with 300 tracked Pins and C = 150 streams finish in about 5.7 hours; the outbound rate is about 150 requests per second, well within one Node process, and the Postgres write rate (about 150 rows per second, batched) is trivial. The tracked-Pin policy keeps T near 300: always the top 50 and the account aggregate; daily for Pins created in the last 90 days, Pins in the top 50 within 30 days and Pins above the tenant median; one seventh of the long tail each night with a 14-day window so no day is missed; a hard cap per plan.

The scheduler is pg-boss (Postgres-backed, no Redis): a `nightly_plan` cron at 00:30 UTC enqueues one `sync_account` job per account with `singletonKey = account_id` and priority by plan. Each job keeps a per-account token bucket row (capacity 60, refill 60/min) but trusts `x-ratelimit-remaining` and `x-ratelimit-reset` headers over the local bucket, sleeps until reset on 429, backs off exponentially with jitter on 5xx (1 s to 16 s, five tries), and on a 401 marks `needs_reauth` and notifies. Progress cursors (`last_pin_index`, `bookmark`) live on the job row so a restart resumes rather than restarts. Trial tier (1,000 requests/day for the whole app) is used only to record fixtures; every agent-loop test runs against those fixtures.

### Retention design consistent with "call the API each time"

| Data class | Retention | Rationale |
| --- | --- | --- |
| Pin content (titles, descriptions, images, board names) | Not persisted; fetched on demand, cached in memory up to 1 hour | Literal compliance with the storage clause |
| Raw metrics per Pin per day (numbers) | Rolling 90 days, matching the API window; dropped by partition | A cache of what the user could re-fetch |
| Derived outputs (incidents, issues, scores, reports, evidence packs) | 13 months default, tenant-configurable | PinPulse's own work product; still purged on disconnect |
| Tokens | Until disconnect or revoke | Encrypted; one `TokenVault` access path with audit |
| Audit log | 12 months hot, then cold | Agency accountability |

Disconnect (user action, agency removal, 14 days of failed re-auth, or Pinterest-side revoke) revokes the token, soft-deletes the connection, enqueues `purge_connection` to hard-delete metrics, derived rows and reports within 24 hours, and writes an audit entry; a nightly assertion job confirms no rows remain for purged connections. The Terms allow 30 days; the design target is 24 hours.

## 7. Tech stack

Every choice below optimises for one founder plus coding agents: the largest agent-knowledge pool, the fewest moving parts, free tiers until real scale, and portability (OpenTelemetry, Postgres, Docker) so nothing locks in.

| Layer | Choice | Alternatives considered | Rationale (sources in section 15) |
| --- | --- | --- | --- |
| Web framework | Next.js 16.4 App Router, TypeScript strict, React 19 | React Router 8 (ex-Remix), SvelteKit 3 | Cache Components give per-tenant dashboard caching without Redis; Vercel ships agent Skills and `next upgrade --agent`; largest ecosystem |
| UI | shadcn/ui + Radix + Tailwind v4 | MUI, Mantine | Owns the code (agents edit components directly); Radix colour scales meet contrast rules |
| Charts | Apache ECharts via echarts-for-react for the annotated timeline; Recharts for sparklines | Observable Plot, visx, uPlot, TanStack Charts | ECharts has markLine/markArea/markPoint annotations, canvas for dense series, SVG renderer for PDF export |
| Backend shape | Modular monolith (Route Handlers, Server Actions) + Node worker in the same repo | Hono/Fastify service, NestJS | Product logic once; Hono reserved if an internal API between worker and web is ever needed |
| Analytics engine | Python 3.12, numpy/scipy, `ruptures`, `statsmodels`, FastAPI, managed with uv | TypeScript port, PyMC at v1 | Mature, BSD-licensed changepoint and decomposition libraries; `ruptures` ships synthetic generators and metrics for property tests; PyMC only for the v2 Bayesian layer |
| Database | Postgres 16 on Neon (Launch) at v1; self-hosted or RDS later; monthly/weekly range partitions; RLS; Drizzle ORM with hand-written policy migrations | Supabase, TimescaleDB, ClickHouse | Neon branching gives a database per PR for agent previews; Supabase is migrating customers off TimescaleDB to pg\_partman; row volumes (about 3 GB at 1,000 accounts, 32 GB at 10,000) fit partitioned Postgres; no cross-tenant analytics allowed, so no ClickHouse |
| Jobs | pg-boss (Postgres-backed) behind a `JobRunner` interface | BullMQ + Upstash Redis, Inngest, Trigger.dev, Temporal | No Redis; cron, retries with backoff, dead-letter and redrive built in; per-step billing on Inngest punishes per-Pin calls; Trigger.dev kept as the swap if observability pain grows |
| Auth | Better Auth with `organization` plugin; Pinterest OAuth handled in our own module, not the generic provider | Auth.js v5, Clerk, Lucia | Lucia is deprecated and points to Better Auth; Auth.js lacks built-in orgs and 2FA; Clerk is per-MAU vendor lock; our own connection table controls encryption, rotation, scopes and deletion |
| Token storage | AES-256-GCM envelope encryption; per-connection data keys wrapped by a versioned KEK (secrets manager at v1, AWS KMS at v3) | Encrypt with one app key | Rotation re-wraps data keys, never rows; Pinterest revokes GitHub-leaked tokens within 24 h, so gitleaks runs pre-commit and in CI |
| Email / Slack | Resend (free 3,000/month, Pro $20); Slack incoming webhooks stored encrypted | Postmark | Cheapest path; Postmark if deliverability complaints appear |
| PDF | Playwright/Chromium on the worker VPS rendering the same React report components; `@react-pdf/renderer` as the serverless fallback | Typst | Charts must match the dashboard; Chromium needs 400–600 MB and fails serverless size limits |
| Observability | Sentry (errors, cron monitors on every scheduled job); OpenTelemetry to Grafana Cloud Free (50 GB logs and traces); Better Stack Uptime (10 monitors, status page) | Axiom, Datadog | All free at v1; OTel keeps the backend swappable |
| Product analytics and flags | PostHog (1M events, 1M flag requests free); flags double as per-tenant detector kill switches | LaunchDarkly, Mixpanel | Zero cost until scale |
| Support | Crisp Free (2 seats); Plain later | Intercom | Cost |
| Billing | Paddle (merchant of record; 5% + $0.50; Pakistan not on its unsupported list) with Lemon Squeezy as fallback (explicit Pakistan bank payouts; but now a Stripe product mid-migration to Stripe Managed Payments) | Shopify Billing (only for a later Shopify App Store SKU) | Stripe is unavailable to Pakistan sellers; verify Paddle onboarding documents in week 1 |
| Monorepo | pnpm workspaces + Turborepo; uv for Python; Biome for TS lint/format; Ruff and mypy for Python | Nx | Turborepo's Python support is experimental; wrap `uv run` in package scripts if flaky |
| Testing | Vitest, Playwright, pytest + Hypothesis, Prism/MSW mock Pinterest from recorded fixtures | Jest, Cypress | Property tests on detectors; contract tests against fixtures; e2e on previews |
| Hosting | v1: Vercel Pro + Neon + one Hetzner CPX VPS (Ashburn) for workers; v2: Hetzner/Coolify or Railway; v3: AWS ECS Fargate + RDS or Hetzner cluster | Fly.io, Railway at v1 | Section 9 has the cost tables |
| Agent tooling | Claude Code with CLAUDE.md, skills, hooks, subagents, sandbox; MCP servers: Postgres (read-only role, dev branch), Playwright, Sentry, GitHub (read-only in automation) | Cursor, Codex | Section 10 |

Versions are pinned in the repo's lockfiles; the stack is re-evaluated at each release gate, not continuously. The one item to watch is Neon's usage bill once the nightly sync keeps compute hot for six hours: at that point the sync writes move to a self-managed Postgres before anything else changes.

## 8. Security, privacy and compliance engineering

PinPulse holds long-lived Pinterest tokens for other people's businesses, so token handling, tenant isolation and deletion are engineered, not policies. The threat model names four assets: OAuth tokens, per-tenant metrics, agency-client trust boundaries, and the Pinterest app registration itself (losing it ends the business).

### Controls by layer

| Area | Control | Verification |
| --- | --- | --- |
| OAuth | Minimal scopes (`user_accounts:read`, `pins:read`, `boards:read`; `*:read_secret` only on opt-in); `a signed state on every authorize (PKCE if Pinterest supports it; its docs do not mention it)`; redirect URI allowlist | E2E test with a mock OAuth server; scope assertion in the connect handler |
| Token vault | AES-256-GCM per-connection data keys, KEK versioned; one `TokenVault` module is the only decrypt path, with structured audit (who, connection, purpose); refresh every 20 days, alert at 50 days; Sentry `beforeSend` scrubs tokens; no token ever in logs or fixtures (`scrub-fixtures` script) | Unit: encrypt/decrypt round trip, KEK rotation re-wrap; grep-based CI check that no fixture contains `access_token` |
| Tenant isolation | Row-level security on every workspace-scoped table; app connects as a non-owner role; `set_config('app.workspace_id', ..., true)` per transaction so pooled connections never leak; policies in hand-written migrations | Integration test per policy asserting cross-tenant queries return zero rows; a nightly job that runs the same assertions in production against synthetic tenants |
| Agency boundary | Agency → workspace → connection; consent recorded per workspace with the Pinterest user id, scopes and timestamp; no cross-client ranking or aggregation; client-viewer role sees only its own workspace | RLS tests; UI snapshot tests that client-viewer screens contain no other client names |
| Deletion | Disconnect purge within 24 h (Terms allow 30 days); `erase_subject(user_id)` revokes tokens, purges connections, deletes Better Auth user and sessions, anonymises audit rows, deletes Resend, PostHog and Crisp records, emits a receipt; certification export for Pinterest on request | E2E: connect, sync, disconnect, assert zero rows via admin API; quarterly manual drill |
| Retention | Raw metrics partitions dropped after 90 days; derived rows per tenant config (13 months default); no Pin content persisted | Partition-drop job monitored in Sentry; schema lint that forbids `title`/`description` columns on metric tables |
| Secrets | Doppler or 1Password CLI injects env; nothing in Coolify UI only; GitHub Actions use OIDC federation, not stored keys; Pinterest app secret rotated quarterly (does not invalidate user tokens) | gitleaks pre-commit and CI; secret inventory in `docs/security/secrets.md` |
| Supply chain | Dependabot weekly grouped updates; Trivy filesystem and image scans as SARIF, failing on fixable HIGH/CRITICAL; CycloneDX SBOM per release; `pnpm audit --audit-level=high`; CodeQL | CI jobs; release checklist |
| Own API and UI | Per-IP and per-user token bucket at the edge (Vercel WAF rules or Hono middleware on a Postgres `rate_limit` table); stricter limits on login and OAuth callback; CSRF via Better Auth; CSP with nonces | Load test with k6 on preview |
| Webhooks | Paddle signature verification on the raw body; Shopify `X-Shopify-Hmac-Sha256` with `timingSafeEqual`, 200 within 5 s, async processing, mandatory `customers/data_request`, `customers/redact`, `shop/redact` handlers | Contract tests with recorded payloads |
| Link checks | Fetch only the user's own Pin URLs; Pinterestbot UA strings exactly as published; honest secondary header `X-PinPulse-Check: 1`; at most 1 request/s per domain; respect Crawl-delay; redirect chains capped at 10 | Unit tests on the fetcher; allowlist of target domains = the tenant's claimed and linked domains |
| Agent sandbox | Claude Code sandbox with `allowUnsandboxedCommands: false`, strict network allowlist (registry.npmjs.org, pypi.org, github.com), credentials denied; Postgres MCP read-only on a dev branch; no production secrets on dev machines | `.claude/settings.json` reviewed in every PR that touches it; hook that rejects diffs deleting test files |

### Pinterest-specific compliance program

1. Keep dated copies of the Developer Terms (August 2026), Developer Guidelines, Community Guidelines (12 Nov 2026 version) and Enforcement page in `docs/policy/`, and subscribe to the developer changelog; every change opens a review task.
2. Obtain and file written answers from Pinterest on analytics storage scope, benchmarking scope and Business Access consent before v1 billing starts.
3. Record the Standard-access review video from the production app; re-submit on material feature changes (agency mode, GA4, Shopify, MCP server).
4. Publish an accurate privacy policy and app description; both are cited rejection reasons in Pinterest's review guidance.
5. Maintain a sub-processor list (Vercel, Neon, Hetzner, Resend, Sentry, PostHog, Paddle, Crisp) and a DPA template for EU agencies; US-East hosting with contractual terms until an EU customer demands residency.

### SOC 2-lite for one founder

SSO and 2FA on GitHub, Vercel, Neon, Hetzner, Paddle and Sentry; branch protection with required CI and signed commits; encrypted backups restored in a quarterly drill; quarterly access review; incident runbook and public status page; written retention and deletion policy mirroring section 6; admin action logging. Vanta or Drata only when an agency asks for a report.

### Incident response

Severity 1 is any token exposure or cross-tenant data leak: revoke all tokens for affected connections, rotate the KEK, notify affected workspaces within 72 hours (EEA/UK breach notice obligation in the Terms), file a Pinterest support notice, and post-mortem within 5 days. Severity 2 is a missed nightly sync or alert outage: status page update, replay from job cursors, no notification needed unless data is older than 72 hours.

## 9. Deployment plan

Infrastructure grows in four stages, each chosen to minimise operations at that scale rather than to be final. v1 costs about $60–75 per month for 100 accounts on Vercel Pro + Neon Launch + one Hetzner worker; the crossover where self-hosting pays for the founder's database time is around 1,000 accounts.

### Stages

| Stage | Trigger | Web | Database | Workers | Monthly cost (estimate) |
| --- | --- | --- | --- | --- | --- |
| v0 dev | Now | Docker Compose: Next.js, Node worker, Python worker (uv), Postgres 16, Mailpit, mock Pinterest API (Prism on recorded fixtures) | Local; Neon Free branch for cloud previews | Local | $0 |
| v1 | First paying users, up to 100 accounts | Vercel Pro, region `iad1` | Neon Launch `us-east`, PITR 7 days, a branch per PR via the Neon GitHub integration | One Hetzner CPX22/CPX32 in Ashburn running Node worker, Python worker and Chromium under Coolify (or Compose + systemd) | $60–75 |
| v2 | 1,000 accounts, or Neon usage above $150 | Stay on Vercel if under $60, else Hetzner behind Coolify/Traefik | Dedicated Hetzner CPX32/CPX42 Postgres with pgBackRest to Cloudflare R2, or Neon if still under $150; weekly partitions with drop | Separate `sync` and `stats`/`pdf` containers; Sentry cron monitors on every job; public status page | $130–200 |
| v3 | 10,000 accounts, or an enterprise agency asking for audit evidence | AWS ECS Fargate or Hetzner 3-node | RDS Postgres Multi-AZ or Patroni on Hetzner; KMS for the KEK | Autoscaled worker tasks; C ≈ 150 concurrent account streams | $550–950 (Vercel/Neon path) or $400–500 (Hetzner path) |

Region: US-East throughout. Pinterest's API and crawler are US-hosted; nightly jobs are latency-insensitive; EU agencies at this scale care about processing terms (DPA, SCCs), not physical location. A second stack in `eu-central-1` or Falkenstein with tenant pinning is added only on a contractual demand.

&#91;embedded content: estimates from vendor pricing pages read 7 Nov 2026 · 3 hosting paths × 3 scales\]

At 10,000 accounts the Neon usage bill, not Vercel, is the line to attack; moving the nightly sync's writes to a self-managed Postgres is what closes the gap to the Hetzner path.

### Environments and promotion

| Environment | Purpose | Data | Deploy trigger |
| --- | --- | --- | --- |
| local | Agent loops and development | Synthetic + recorded fixtures; no real tokens | `pnpm dev` |
| preview | One per PR: Vercel preview + Neon branch + worker image tagged by PR | Seeded synthetic tenants; mock Pinterest | PR opened or updated |
| staging | Release candidate; real Pinterest app in Trial tier against the founder's own test accounts | Founder's accounts only | Merge to `main` |
| production | Customers | Real | Tag `v*` after staging smoke test; GitHub Environment with required reviewer (the founder) |

### CI/CD pipeline

GitHub Actions (seeded in the repo): typecheck and lint → unit tests (Vitest, pytest) → analytics benchmark gate (fails on regression beyond 0.01) → contract tests against recorded Pinterest fixtures with 429/401/5xx cases and pagination → migration dry-run on the PR's Neon branch → Playwright e2e on the preview → gitleaks, Trivy, CodeQL, SBOM → Sentry release. A separate `claude-code-review.yml` runs the official code-review action on every PR. Worker deploys are `docker compose pull && up -d` over SSH (Coolify handles this with per-branch previews); web deploys are Vercel's atomic deploys; rollbacks are a redeploy of the previous image or Vercel promotion of the prior build. Jobs are idempotent and resumable, so rolling restarts are safe at any time.

### Infrastructure as code

v1 keeps IaC small: `docker-compose.*.yml`, Dockerfiles, and a `terraform/` folder for the Hetzner server, firewall, Cloudflare DNS, R2 bucket and the Neon project (Neon has a Terraform provider). v3 grows into Terraform or SST for AWS with GitHub OIDC roles.

### Backups and recovery

Neon PITR (7 days) plus a nightly `pg_dump` to Backblaze B2 or Cloudflare R2 off-provider; quarterly restore drill into a fresh branch with a checksum comparison; recovery objectives RPO 24 hours (one nightly sync is reproducible from the API anyway for the last 90 days) and RTO 4 hours. Fixture files and the synthetic benchmark are in git; the KEK is in the secrets manager with a sealed offline copy.

### Observability

OpenTelemetry SDK in web and workers exporting traces and logs to Grafana Cloud Free; Sentry for exceptions and cron monitors (`nightly_plan`, `sync_account` success rate, `purge_connection`, partition drop); Better Stack uptime monitors on `/healthz` for web and analytics and a public status page; PostHog for product events (connect, first incident viewed, alert set, report shared). Four golden signals per nightly run: accounts synced / planned, API error rate by status, median sync minutes per account, analytics latency p95. A sync that completes under 90% of planned accounts pages the founder.

### Release cadence

Weekly releases from `main` behind PostHog flags; detector changes ship dark first (shadow-scored against the live detector for a week, compared on the labelled set) and are flipped per tenant.

## 10. Agent-driven programming and loop engineering

The founder is product owner, spec author, reviewer and release manager; agents do exploration, implementation, tests, first-pass review, docs and migration drafts. The operating model follows what the 2025–2026 evidence says works: specs expanded into a machine-checked feature list, one task per fresh session, tests as back-pressure, held-out checks the agent cannot edit, iteration caps, and a human at every irreversible gate.

### What the evidence says

| Finding | Source | Rule it produces |
| --- | --- | --- |
| Long-running agents work best with an initializer that writes a progress file and a JSON feature list where agents may only flip `passes`; browser-based end-to-end checks caught far more bugs than unit tests | Anthropic, "Effective harnesses for long-running agents" (Nov 2025) | `specs/<id>/tasks.json` with `verify` commands; Playwright e2e on every preview |
| Credentials never in the sandbox; sandboxes disposable; session is an append-only event log | Anthropic, "Scaling Managed Agents" (Apr 2026) | Doppler-scoped tokens, no production secrets on dev machines, worktree per session |
| Repair loops gain most in the first 3–4 iterations and about nothing after 5–7 | Reichmann et al. 2026 | Cap at 5 iterations per task; write a failure note and move on |
| Forced revision can lose a correct patch ("currently correct" fell from 0.82 to 0.67 after a second revision); stale verifier traces harm | Gao, Yang & Yang 2026 | Commit and tag on green; never overwrite a passing state without a fresh green run; bind evidence to the commit hash |
| Agents retrieved fixes from upstream PRs, mined `.git` history and hard-coded expected strings; sealing history and egress cut scores 14–21 points | SWE-Bench Pro Verified 2026; Cursor (Jun 2026) | Held-out tests in a read-only directory run by the outer script; network allowlist; no hidden-test access |
| Single-run pass@1 varies 2–6 points even at temperature 0 | Bjarnason, Silva & Monperrus 2026 | Re-run flaky evaluations three times before believing a regression or an improvement |
| Keep CLAUDE.md short; give a verifiable check; writer and reviewer in separate sessions; restart after two failed corrections | Claude Code best practices | CLAUDE.md under 150 lines; reviewer subagent with read-only tools |

&#91;embedded content: development loop · 6 steps, 2 human gates, 1 bounded loop\]

### The loop, step by step

1. Spec. Founder and Claude in plan mode write `specs/SPEC-0NN.md` (why, user story, acceptance criteria as checkboxes, data and policy, design states, test plan, rollout). Each criterion maps to a `verify` command. Specs that touch billing, OAuth scopes, deletion or Pinterest policy text are marked `risk: high`.
2. Plan and tasks. Claude writes `plan.md` and `tasks.json` (task, verify command, `passes: false`); the founder approves the task list, not the code.
3. Implement. A fresh Claude Code session per task in its own git worktree, sandbox on (`allowUnsandboxedCommands: false`, network allowlist `registry.npmjs.org`, `pypi.org`, `github.com`, credentials denied), `--max-turns` and a nightly cost ceiling. The session reads the spec, writes failing tests, implements the smallest change, runs the gate.
4. Test gate (hooks). `PostToolUse` on Edit/Write runs Biome or Ruff; a `Stop` hook re-runs the affected tests and returns exit 2 to keep the agent working, with a loop guard at 5; `PreToolUse` on `git push` asks. A hook rejects any diff that deletes a test file or edits `benchmark_baseline.json` outside a detector PR.
5. Review. A reviewer subagent with read-only tools and fresh context checks the diff against the spec and the non-negotiables; a second security-angle subagent reviews anything touching tokens, RLS or deletion; the official code-review GitHub Action comments on the PR.
6. Merge. The founder merges only when CI is green (section 9), the preview was smoke-tested by an agent through Playwright MCP, and any migration was read by a human. High-risk specs require the founder to read the whole diff.
7. Record. Every run writes a row to `agent_run` (task, model, turns, cost, first-CI-pass, review iterations, human-rewrite lines, merged, reverted within 14 days).

### Repository structure (seeded)

`CLAUDE.md` (operating rules, repo map, non-negotiables, loop protocol), `specs/` (template and index of 17 seed specs), `.claude/skills/detector-loop/SKILL.md` (the detector improvement loop), `.github/workflows/ci.yml` (web, analytics with benchmark gate, e2e, security), `services/analytics` (detectors, synthetic benchmark, tests, FastAPI), `docs/adr/0001` (architecture decision), `docs/detector-log.md`, `docker-compose.yml`, `scripts/bench_failures.py`. Next to add: `.claude/agents/{implementer,reviewer,security-reviewer,e2e-tester}.md`, `.claude/settings.json` (sandbox, hooks, `permissions.deny`), `.mcp.json` (Postgres read-only on a dev branch, Playwright, Sentry, GitHub read-only), `docs/constitution.md`.

### Skills to write (each a `.claude/skills/<name>/SKILL.md`)

| Skill | Purpose | Status |
| --- | --- | --- |
| `detector-loop` | Pick the weakest benchmark metric, one hypothesis, failing test, smallest change, accept only on multi-seed improvement, log | Written (in repo) |
| `spec` | Scaffold a spec from the template with EARS-style criteria and verify commands | To write, week 1 |
| `review` | Checklist review: spec coverage, non-negotiables, tenant isolation, token paths, test deletion, migration safety | To write, week 1 |
| `fixture-record` | Record and scrub a Pinterest API fixture set on the Trial app for a named scenario | To write, week 2 |
| `release` | Changelog, tag, Sentry release, staging smoke test, production promote, rollback note | To write, week 4 |
| `policy-recheck` | Diff the stored Pinterest policy copies against live pages; open review tasks for changes | To write, week 2 |
| `pinterest-ticket` | Draft the creator-stats-drop ticket from an evidence pack in Pinterest's requested format | To write, v1 |

### Metrics (weekly, from `agent_run`)

Task success rate (merged without human rewrite), first-CI-pass rate, rework rate (human-changed lines over agent lines), revert rate within 14 days, cost per merged task, cycle time split agent/human. Targets for month 3: first-CI-pass above 60%, rework under 20%, revert rate under 5%. No single metric is trusted alone.

### What humans must still do

Approve specs; review migrations and anything touching tokens, RLS, deletion or billing; read every diff in the Pinterest client; record the Standard-access video; email Pinterest; sign vendor terms; own incidents; talk to customers. The loop makes code cheap; it does not make judgement cheap.

## 11. Testing and evaluation strategy

PinPulse has four things to evaluate, and each needs its own harness: the detector (does it find real cliffs and name the cause?), the alerts (do users find them useful?), the software (does it work and stay compliant?), and the agents that build it (are they getting better or gaming the tests?). The rule across all four: the thing being evaluated never controls its own evaluation data.

### A. Detector evaluation

| Layer | Data | Metrics | Gate |
| --- | --- | --- | --- |
| Synthetic benchmark (frozen) | 300 generated accounts per seed, negative-binomial daily counts, weekly seasonality, trend, five labelled cause classes, 20% with no cliff | Onset precision/recall/F1 within ±2 days; class accuracy (top-1 and top-2); false-alarm rate on no-cliff accounts; detection delay in days; score = 0.4 F1 + 0.4 accuracy + 0.2 (1 − FAR) | CI fails on regression beyond 0.01 on seed 7; acceptance of an improvement needs seeds 7, 11, 23 (variance is real: single-run scores move 2–6 points in the agent literature) |
| Property tests (Hypothesis) | Random piecewise-constant series with known breakpoints from `ruptures` generators; stationary noise; scaled copies | Recall ≥ 0.9 for drops ≥ 70%; zero changepoints on stationary noise at the stated false-alarm rate; invariance to scale; monotone response to effect size; no lookahead (truncating the series after day t never changes a verdict dated before t) | Part of `pytest`; failures block merge |
| Replayed real series (held out) | Anonymised series from concierge audits and consenting users, labelled by the founder with the user's confirmed outcome (block lifted, Pinterest admitted a bug, viral Pin decayed, seasonality) | Same metrics as synthetic, reported separately; calibration (reliability diagram of stated confidence vs observed accuracy; expected calibration error under 0.1) | Stored outside the agent-editable tree; run by the outer script only; refreshed monthly |
| Shadow mode in production | Every detector change runs dark for one week next to the live detector on all accounts | Agreement rate; disagreements reviewed by hand; alert volume delta | Flip per tenant via PostHog flag only after review |
| Drift monitoring | Weekly | Onset-rate distribution, class mix, confidence histogram, share of "insufficient data" verdicts | Alert when any distribution shifts beyond its 8-week band |

Label policy: a real-series label is written only when the outcome is confirmed by an external fact (Pinterest message, restored distribution after a specific fix, matched-pair result), never by the detector's own output. Ambiguous cases are labelled "unknown" and excluded from accuracy but included in calibration.

### B. Alert and product evaluation

| Question | Measure | Instrument |
| --- | --- | --- |
| Are alerts useful? | Precision as judged by users: share of alerts marked useful; target ≥ 80% at tier 2 | One-click "useful / not useful" on every alert; feeds the cost ratio p\* and background rate p₀ |
| Did we explain the drop? | Share of incidents where the user accepts a cause ("this matches what happened") within 7 days | Cause-card feedback; monthly review of rejected causes |
| Did the product activate? | Workspaces that view a cause card for a detected changepoint and keep one alert within 24 h | PostHog funnel |
| Does it retain VAs? | First report shared within 7 days; month-2 retention by persona | PostHog cohorts, Paddle |
| Is the weather index honest? | Agreement between user-reported onsets and detector onsets; later, between index and authorized pooled data | Weekly comparison job |
| Is the copy safe? | No "recovery", "guarantee", "shadowban" in UI or email strings | Lint rule over the i18n catalogue in CI |

### C. Software quality

| Level | Scope | Tooling |
| --- | --- | --- |
| Unit | Pinterest client (buckets, headers, backoff, pagination to `bookmark: null`), schedulers, alert tiers, token vault round trip and KEK rotation, rules engine | Vitest, pytest |
| Contract | Every client method replayed against recorded, scrubbed fixtures including 429, 401, 5xx and header variants; a nightly fixture-drift job re-records a small sample on the Trial app and diffs schemas | Prism/MSW mock server; fixtures versioned by API date |
| Integration | pg-boss jobs against Postgres with a fake clock; RLS policy tests asserting zero cross-tenant rows for each policy; purge-on-disconnect leaves zero rows | Testcontainers or CI Postgres service |
| End-to-end | Connect via mock OAuth; sync; dashboard loads; incident visible; alert set; PDF generated and contains expected strings; disconnect purges | Playwright on the PR preview with its own Neon branch |
| Load | Nightly sync at 10× the current account count against the mock Pinterest; alert evaluation at 10,000 accounts | k6, monthly |
| Accessibility | Every screen passes axe with no serious violations; keyboard path through each wizard | Playwright + axe in CI |
| Visual | Report PDF snapshot diff per release | Playwright screenshots |

### D. Agent evaluation (loop engineering)

| Risk from the literature | Evaluation | Mechanism |
| --- | --- | --- |
| Agents loosen thresholds or edit tests to pass | Held-out suite in a read-only directory with numeric tolerances; hook rejects test deletions; benchmark generator frozen | Outer script runs the held-out suite after every agent session; diff audit for `tests/` and `synth.py` |
| Agents mine git history or upstream code for answers | Not applicable to greenfield code, but fixtures and expected strings live outside the editable tree | Sandbox with network allowlist; fixture directory read-only in the loop |
| Reward hacking on the detector benchmark | Multi-seed acceptance; a hidden fourth seed evaluated weekly by the founder; the scoring formula is fixed in the spec, not in the editable code | `detector-loop` skill rules; `scripts/bench_failures.py` shows what changed |
| Run-to-run variance mistaken for improvement | Three runs before accepting a change; report mean and spread | CI job matrix on seeds |
| Losing a passing state through forced revision | Tag on green; later iterations may not overwrite a tagged state without a fresh green run | Git tags `green/<task>`; outer loop logic |
| Unbounded loops and cost | Iteration cap 5 per task; nightly cost ceiling; failure note on cap | Hook loop guard; `agent_run` cost column |

Weekly agent scorecard: task success rate, first-CI-pass rate, rework rate, revert rate, cost per merged task, and a sampled human audit of five merged PRs for spec fidelity. A rise in first-CI-pass with a rise in revert rate is the signature of gaming and triggers a review of the gate itself.

### E. Evaluation of any LLM-generated text in the product

If cause narratives, report summaries or ticket drafts are generated by a model, they are evaluated like the detector: a golden set of 50 incidents with founder-written reference summaries; automatic checks for forbidden claims (no promises, no "shadowban", numbers must match the incident record exactly); a rubric-graded pairwise comparison on each prompt change; and a human read of 10% of generated reports in the first three months. Numbers are never generated by the model; they are templated from the incident record.

## 12. Go-to-market, pricing and packaging

The buyer's money is already on the table: a Pinterest manager's published tool stack costs about $92 a month (PinClicks $29, Tailwind $30, Canva, ChatGPT, two $27-a-year utilities) and retainers run $300–$1,500 per client per month, with "performance reporting" the feature that separates the $600 tier from the $1,000+ tier (DDIY, Feb 2026). A health and reporting layer at $8 per account is under 3% of the cheapest retainer.

### Competitive pricing (verified 7 Nov 2026)

| Tool | Price | Post-publish monitoring | Alerting |
| --- | --- | --- | --- |
| Tailwind | $11.99–$17.99 per module, $29.98 bundle, all per Pinterest account | Keyword rank tracking; no drop diagnosis | None |
| PinClicks | Pin Pro $29, Pin Plus $49 | Keyword rankings, Account Explorer | Pin Plus only: AI-Modified flags and Visit-site removal emails |
| PinGenerator | Credit tiers; free one-off profile audit scored /100 | Audit kept 90 days; Pin history | Trend alerts only |
| BlogToPin | $25 / $50 / $125, unlimited accounts | Basic analytics; deletes underperformers | None |
| Later | $18.75–$82.50; Pinterest analytics capped at 3 months | Basic | None |
| Metricool | Free to $159; about $3 per marginal brand | Cross-network reports | None |
| Circleboom | "Pinterest shadowban checker" page with unexplained method | None | None |

No tool does changepoint detection, cause classification, cohort comparison or evidence packs. PINREVOS could not be found and is treated as non-existent until shown otherwise. Pinterest's own Business Assistant (June 2026, closed beta) and MCP server (alpha, holding-company agencies) are ads-centric; PinPulse positions on organic, multi-client and independent evidence.

### Pricing ladder

| Tier | Price | Accounts | Includes | Rationale |
| --- | --- | --- | --- | --- |
| Free: Drop Check / Traffic Leak Check | $0 | 1, CSV or read-only OAuth | One-off report: onset date, Pin decomposition, signature, domain checklist; emailed; expires 14 days | Mirrors PinGenerator's free audit but post-publish; captures email and niche; seeds the weather index with consent |
| Solo | $19/month ($15 annual) | 1 | Daily monitoring, health score, cause cards, email alerts, 13-month derived history | Just under PinClicks Pro; blogger-friendly |
| Pro (VA) | $39/month ($32 annual) | 5, +$6 each | Client workspaces, branded report builder, Slack alerts, matched-pair wizard, evidence pack | About $8 per account, under 3% of a $300 retainer |
| Agency | $99/month ($82 annual) | 20, +$5 each | White-label reports and status pages, team seats, API and MCP, priority support, niche cohort context once authorized | Undercuts BlogToPin Enterprise and Metricool Advanced; white-label is Metricool's custom-only feature |

Billing hygiene is a trust feature, because Tailwind's Trustpilot wounds are renewal surprises and hard cancellation: renewal reminder 7 days before an annual charge, one-click cancel, prorated refunds within 14 days, printed on the pricing page. 14-day trial, no card; Agency gets concierge import.

### Activation and onboarding

1. Connect Pinterest (OAuth), pick a niche; VAs add clients by sending a consent link the client approves.
2. Backfill 90 days from the API (plus a 1.5-year CSV import if offered); detect changepoints; show the first annotated drop and cause card immediately.
3. Set one alert rule (default: changepoint confirmed by two methods with effect ≥ 50%, or any Visit-site or domain-claim change).
4. Generate the first one-page report and share link.

Activation metric: share of new workspaces that view a cause card for a detected changepoint and keep one alert within 24 hours. Leading retention indicator: first report shared within 7 days.

### Channels (where Pinterest VAs are)

| Channel | Play |
| --- | --- |
| Pinterest Business Community | Reply to drop threads with the weather map and a free Drop Check link; recruit 2–3 Pioneers as design partners |
| Kristin Larsen's Pinterest VA course ($997, private community) and Simple Pin Media (SPM Insiders $9/month, 15,000-subscriber newsletter, podcast) | Sponsor a module on diagnosing drops for clients; guest podcast episodes with the cause taxonomy |
| Dish It Out Social, Jen Vazquez, Cara Chace, Tailwind Communities | Affiliate partnerships: 30% recurring for 12 months beats Tailwind's one-time $120 after about 10 months on a $39 plan |
| Reddit r/Blogging, r/PinterestMarketing, r/socialmedia; Fiverr and Upwork VA listings | Data-backed answers, not promotion; the free tool link only when asked |
| SEO | "Pinterest impressions dropped" (SERP is forum threads plus two Tailwind posts; no tool page ranks), "Pinterest shadowban" (reframed "Not-a-shadowban checker" page), "Pinterest Visit site button missing" (definitive diagnostic page plus free scan), "AI modified label Pinterest", "limited distribution Pinterest" |
| Public weather page | Weekly index of impression change by niche; the linkable "it's not just you" asset |

### Launch sequence

Weeks 1–4: free Drop Check live; 20 interviews (10 VAs, 5 Shopify merchants, 5 bloggers); 10 concierge audits at $49. Weeks 5–16: v1 private beta with 15 VAs from interviews; public launch on the Business Community and two podcasts when Standard access is granted; Product Hunt only after 30 paying workspaces. Months 5–6: agency tier launch with three design-partner agencies and white-label reports. Months 7–12: weather index (authorized or user-reported) and Shopify join; Shopify App Store listing only if merchant interviews justify it.

Kill criteria: fewer than 10 concierge audits sold by week 6, or fewer than 30 paying workspaces by week 20 (billing opens in week 10 and trials run 14 days, so week 16 is too early to judge), or Pinterest refusing Standard access twice, or a written "no" on storing organic analytics (Terms §4.1(a)) with no CSV-only product that users will pay for. Each triggers a stop-and-rethink before further build.

## 13. Roadmap

Twelve months from 10 Nov 2026, four releases, three hard gates. Two lead items are sequenced first: the written answer from Pinterest on storing organic analytics (asked in week 2; SPEC-002, SPEC-003 and billing may not start until it is filed), and Standard API access, whose review requires a video of this app's own OAuth flow, so the application goes in as soon as SPEC-001 exists (week 6) and community threads suggest 2–4+ weeks of review. Everything in v0 runs on CSV imports and fixtures so neither wait costs build time.

&#91;embedded content: roadmap · 4 releases, 3 gates, Nov 2026 to Nov 2027\]

### Week-by-week, first 16 weeks

| Weeks | Build (agents) | Founder | Gate |
| --- | --- | --- | --- |
| 1 | Repo hardening: `.claude/settings.json`, agents, hooks, `spec` and `review` skills; Paddle account application; Pinterest Trial app registered; privacy policy and app description written | Interview script; outreach to 30 VAs via Business Community, Larsen and Simple Pin communities |  |
| 2 | SPEC-010 CSV import; SPEC-011 changepoints; SPEC-014 decomposition; Drop Check report page; `fixture-record` and `policy-recheck` skills | Email to Pinterest developer support with the eleven questions (storage consent first); policy copies stored in docs/policy; verify on day 1 that the Trial app returns real organic analytics for the founder's own account (if not, fixtures must come from CSV exports) |  |
| 3 | Drop Check landing page and email capture; weather report form (user-reported onsets); 12 Nov guideline diff applied to rules | First 10 interviews |  |
| 4 | Fixture suite from Trial app; Pinterest client with buckets, backoff, pagination; contract tests | Interviews 11–20; 10 concierge audits at $49 sold | Gate 1: 300 reports, 25 bookings, 10 audits |
| 5–6 | SPEC-001 OAuth connect/disconnect with purge; SPEC-003 retention; SPEC-002 nightly sync; RLS policies and tests | Concierge audits delivered by hand with the v0 engine; labels collected; record the Standard-access video on the new OAuth flow and submit the application; SPEC-002/003 start only if the storage-consent answer is filed (else CSV-only path) |  |
| 7–8 | SPEC-012 cause classifier v1; SPEC-013 rate stability; health score; annotated timeline and cause card UI | Design artboards reviewed with 5 VAs |  |
| 9–10 | SPEC-020 link and domain integrity; SPEC-021 pre-flight rules; issues grouping | Private beta with 15 VAs on CSV imports and the founder's own accounts (Trial is sandbox-only; real client connections wait for Standard access); SPEC-060 Paddle billing pulled forward to week 10 so paid trials can start as soon as access lands |  |
| 11–12 | SPEC-022 evidence pack; SPEC-023 monthly report (Chromium PDF); alerts tiers and Slack | Standard access expected; real beta accounts connected |  |
| 13–14 | Onboarding flow; activation events; status page; runbooks; online CUSUM warning path (the 3-day flag) shipped before any alert goes to a customer | Pricing page live; billing hygiene features |  |
| 15–16 | Load test at 10×; shadow-mode harness; accessibility pass; public launch assets | Launch on Business Community and two podcasts | Launch; Gate 2 is judged at week 20 (30 paying workspaces, alert precision ≥ 80% on labelled cases) because trials run 14 days |

### Months 5–12

| Month | Scope | Gate |
| --- | --- | --- |
| 5–6 | SPEC-040 agency workspaces, consent links, roles, white-label reports; SPEC-041 GA4 Traffic Leak Check; weekly agent scorecard review; v2 detector in shadow (BOCPD, NB-GLR per Pin) | Gate 3: 100 workspaces; 3 agencies with 10+ accounts |
| 7–8 | Weather index v1 from user reports and forum counts; authorization request filed with incident-index proposal; calibration study on labelled set; Bayesian network prototype if labels ≥ 300 |  |
| 9–10 | SPEC-050 Shopify order join (per-Pin utm\_content token proof of concept first); CausalImpact "just me" score behind a flag; duplicate-image clustering | Shopify App Store only if merchant interviews justify |
| 11–12 | Infra v2 decision (Neon bill vs Hetzner); SOC 2-lite evidence folder; MCP server for agency tier under the Intermediary Tools clause; annual policy re-read | 150 workspaces; about $6k MRR; infra under $400/month |

Kill criteria (repeated from section 12): fewer than 10 concierge audits by week 6; fewer than 30 paying workspaces by week 20; Standard access refused twice. Each is a stop-and-rethink, not a quiet continuation.

## 14. Risks, open questions and decisions needed

The plan's single largest risk is policy, not competition or engineering: PinPulse's whole product depends on one Pinterest app registration, and one enforcement email could end it. Everything in sections 2, 6 and 8 is designed to make that email unlikely; the items below are what remains.

### Risk register

| Risk | Likelihood | Impact | Mitigation | Owner |
| --- | --- | --- | --- | --- |
| Pinterest reads the storage clause strictly and disallows metric snapshots | Medium | Fatal to history features | Written consent request in week 2; design keeps raw data to 90 days; fall back to user-imported CSV history as the user's own data | Founder |
| Standard access delayed or denied | Medium (community reports 2–4+ weeks, unexplained denials) | Delays v1 by 1–2 months | Apply week 2; accurate app description and privacy policy; v0 runs on CSV; resubmit with a tighter scope | Founder |
| Weather index never authorized | Medium | Loses the most distinctive feature | User-reported index plus forum counts; canary accounts; keep the authorization conversation open with a support-load pitch | Founder |
| Pinterest ships organic alerts in Business Assistant | Low in 12 months (ads-centric, partner-gated) | Erodes differentiation | Position on multi-client, independent evidence, link integrity and reports; MCP consumer later | Product |
| VAs do not actually lose clients over drops | Unknown (no first-hand evidence yet) | Weakens the primary persona | 20 interviews and 10 paid audits before v1 pricing is fixed; the kill criteria at weeks 6 and 20 | Founder |
| Alert fatigue or false alarms destroy trust | Medium | Churn | BH control, cost-sensitive thresholds, shadow mode for detector changes, user feedback loop, precision target ≥ 80% | Engineering |
| Agents game the tests or regress the detector | Medium | Silent quality decay | Held-out suite outside the editable tree, frozen benchmark, multi-seed acceptance, hooks against test deletion, weekly scorecard | Founder |
| Paddle verification problems from Pakistan | Low–medium | No way to charge | Apply week 1; Lemon Squeezy fallback (explicit Pakistan bank payouts, but a Stripe product mid-migration); Shopify Billing for a Shopify SKU only | Founder |
| Neon usage bill spikes with nightly load | Medium at 1,000 accounts | Margin | Monitor compute hours; move sync writes to self-managed Postgres at the $150 threshold | Engineering |
| Token leak | Low | Severe | Envelope encryption, single vault path, gitleaks, scrubbed fixtures, incident runbook | Engineering |
| Guidelines change again (next update after 12 Nov 2026) | High over 12 months | Rules drift | `policy-recheck` skill, dated copies, changelog subscription | Engineering |
| Solo-founder bus factor | Certain | Continuity | Runbooks, ADRs, specs and CLAUDE.md are written for a stranger; quarterly restore drill | Founder |

### Open questions (to resolve before the gate they block)

1. Does the Terms §4.1(a) analytics storage exception cover organic account analytics stored by a third-party app for that account holder? Blocks v1.
2. Is comparing an account to Pinterest-published thresholds "benchmarking"? Blocks the pre-flight copy.
3. Does an agency's Business Access to a client account satisfy "expressly granted access" for storage? Blocks v2.
4. Are perceptual hashes of the user's own Pin images storable as derived data? Blocks duplicate clustering persistence.
5. What is the official organic analytics lag and the meaning of `date_availability.is_realtime`? Affects alert timing.
6. Will Pinterest grant bulk Pin analytics (beta) and a higher per-user limit for agencies? Affects sync cost.
7. Do VAs lose clients over drops, and would clients connect Shopify and GA4 to a VA's tool? Blocks v2 scope.
8. Does a per-Pin `utm_content` token survive from the Pinterest iOS app to Shopify order UTMs, with organic auto-UTMs on? Blocks v3.

### Independent review (7 Nov 2026) and what changed

A fresh reviewer who had not seen the plan being written audited it against the research reports and the seeded code. Fixed in this version: the v1 alert promise (was "within 48h", now "flag within 3 days, confirm with cause within 7–9 days", derived from data lag plus confirmation window); the pricing unit (per workspace, not per account) and an explicit $70k-ARR year-one framing; the Standard-access application moved after SPEC-001 because the review video must show this app's OAuth flow; billing pulled to week 10 and Gate 2 judged at week 20; beta no longer assumes Trial-tier client data; a hard gate that SPEC-002/003/060 wait for Pinterest's written storage answer, with a CSV-only fallback; the benchmark no longer leaks labels through side signals, reports delay and a confusion matrix, has an absolute CI floor, and forbids baseline edits in detector PRs; a no-lookahead test; Redis removed from the dev stack; retention aligned at 13 months; PKCE claim corrected.

Accepted but not yet changed (founder decisions): v1 infrastructure can collapse to Vercel + Neon alone, adding the Hetzner box only when Chromium PDFs ship (week 11); Terraform, SBOM, CodeQL and Grafana can wait for the v2 gate; three chart libraries can become one (ECharts) if sparklines are drawn with it too; the plan is long, and sections 5, 8 and 9 can move to ADRs once approved. Known weak spots that remain honest rather than hidden: E\_decay detection is 0.00 on the benchmark until a fade-shape detector exists; A-versus-D confusion needs a per-domain breadth signal (the next loop hypothesis); storing Pin URLs in `pin_meta` is "information" under a strict reading of the storage clause just as hashes are, and is covered by the same written question to Pinterest.

### Decisions needed from the founder this week

- [ ] Approve the modular monolith + Python analytics architecture (ADR-0001) and the Next.js / Postgres / pg-boss / Better Auth stack.
- [ ] Approve running one Hetzner VPS alongside Vercel and Neon at v1.
- [ ] Apply for Paddle and register the Pinterest Trial app under the final company name.
- [ ] Confirm the pricing ladder ($19 / $39 / $99) for the interviews, or set a different anchor.
- [ ] Confirm the first-buyer bet (VAs and small agencies) and the interview target list.
- [ ] Decide whether the free tool launches as "Drop Check" (CSV) or "Traffic Leak Check" (GA4) first; the plan assumes Drop Check because it needs no integrations.

## 15. Sources

Pages opened on 7 Nov 2026 by the five research streams. The full stream reports (academic methods, Pinterest platform, competitors and design, engineering stack, graph engineering) are saved in the project as `claude/pinpulse-research-*.md` and in the repo under `docs/research/`.

### Pinterest (primary)

- [OpenAPI spec v5.28.0](https://raw.githubusercontent.com/pinterest/api-description/main/v5/openapi.json) · [Rate limits](https://developers.pinterest.com/docs/reference/rate-limits/) · [Authentication and scopes](https://developers.pinterest.com/docs/getting-started/authentication-and-scopes/) · [Access tiers](https://developers.pinterest.com/docs/key-concepts/access-tiers/) · [Developer Terms (Aug 2026)](https://developers.pinterest.com/terms/) · [Developer Guidelines](https://policy.pinterest.com/en/developer-guidelines)
- [Community Guidelines](https://policy.pinterest.com/en/community-guidelines) · [Guidelines preview, effective 12 Nov 2026](https://policy.pinterest.com/community-guidelines-preview) · [Enforcement](https://policy.pinterest.com/en/enforcement) · [Pinterestbot](https://help.pinterest.com/en/business/article/pinterestbot) · [Pinterest Analytics](https://help.pinterest.com/en/business/article/pinterest-analytics) · [Organic URL parameters](https://help.pinterest.com/en/business/article/url-parameters-for-organic-content) · [Conversion insights](https://help.pinterest.com/en/business/article/conversion-insights) · [Pin link update (May 2025)](https://create.pinterest.com/en-ca/blog/pin-link-update/)
- Community: [PINNER\_DATA\_ACCESS\_DENIED (1 Oct 2026)](https://community.pinterest.biz/t/understanding-the-pinner-data-access-denied-access-error/51738) · [Trial access backlog](https://community.pinterest.biz/t/known-issue-support-for-trial-access-pending-or-denied-access/50249) · [Analytics lag thread](https://community.pinterest.biz/t/v5-user-account-analytics-returning-delayed-data-48-hours-old-for-organic-analytics/46517) · [How to get support for impression drops](https://community.pinterest.biz/t/how-to-get-support-for-impression-drops/49965) · [Per-Pin August drop measurement](https://community.pinterest.biz/t/i-measured-my-august-drop-per-pin-every-pin-older-than-7-days-lost-95-in-48-hours-new-pins-untouched/50281) · [Impressions down 90% since Oct 29](https://community.pinterest.biz/t/impressions-down-90-since-oct-29-top-pins-missing-from-search/52914.md) · [Ad auto-UTM announcement](https://community.pinterest.biz/t/automatic-utm-parameters-for-eligible-ad-destination-urls/51935)
- Engineering: [How Pinterest fights spam using ML](https://medium.com/pinterest-engineering/how-pinterest-fights-spam-using-machine-learning-d0ee2589f00a) · [Label-based enforcement pipeline](https://medium.com/pinterest-engineering/building-a-label-based-enforcement-pipeline-for-trust-safety-4b05a409cb5d) · [Keeping Related Pins fresh](https://medium.com/@Pinterest_Engineering/6b0e2876d7e) · [PinSage](https://arxiv.org/abs/1806.01973) · [Pixie](https://arxiv.org/pdf/1711.07601.pdf) · [PinnerSage](https://arxiv.org/abs/2007.03634) · [PinnerFormer](https://arxiv.org/abs/2205.04507v1) · [TransAct](https://arxiv.org/pdf/2306.00248) · [PinRec](https://arxiv.org/abs/2504.10507) · [SEINE spam GNN](https://arxiv.org/abs/2207.10767) · [Near-duplicate image detection](https://arxiv.org/pdf/2209.08433) · [Pin cohesion](https://medium.com/pinterest-engineering/building-pin-cohesion-229c19fc617e)
- Financials: [Q3 2026 8-K](https://www.sec.gov/Archives/edgar/data/0001506293/000150629326000151/q3-26xpressrelease.htm)

### Detection and statistics

[Adams & MacKay 2007, BOCPD](https://arxiv.org/abs/0710.3742) · [Killick, Fearnhead & Eckley 2012, PELT](https://arxiv.org/abs/1101.1438v3) · [Truong, Oudre & Vayatis 2020, ruptures review](https://arxiv.org/abs/1801.00718) · [Knoblauch et al. 2018, robust BOCPD](https://proceedings.neurips.cc/paper/2018/hash/a3f390d88e4c41f2747bfa2f1b5f87db-Abstract.html) · [Bardwell et al. 2017, panel changepoints](https://arxiv.org/pdf/1609.06805) · [Hochenbaum et al. 2017, S-H-ESD](https://arxiv.org/abs/1704.07706) · [Höhle & Paul 2008, NB-GLR](https://cran.r-universe.dev/surveillance/doc/glrnb.pdf) · [Taylor & Letham, Prophet](https://facebook.github.io/prophet/static/prophet_paper_20170113.pdf) · [Brodersen et al. 2015, CausalImpact](https://arxiv.org/abs/1506.00356) · [Abadie et al. 2010, synthetic control](https://www.mit.edu/~jhainm/Paper/ccs.pdf) · [Johari et al., always-valid inference](https://arxiv.org/abs/1512.04922v2) · [Sharma, Li & Jiao, counterfactual Shapley](https://arxiv.org/pdf/2208.08399) · [Cha et al. 2007, YouTube popularity](https://www.cl.cam.ac.uk/~jac22/camhor/mia_imc07_sumitted.pdf) · [Clauset et al. 2009, power laws](https://arxiv.org/abs/0706.1062) · [Benjamini & Hochberg 1995](https://www.dcscience.net/Benjamini-Hochberg-1995-FDR.pdf) · [Elkan 2001, cost-sensitive learning](https://mlanthology.org/ijcai/2001/elkan2001ijcai-foundations) · [Google SRE, monitoring](https://sre.google/sre-book/monitoring-distributed-systems/) · [ruptures docs](https://centre-borelli.github.io/ruptures-docs/)

### Visibility audits and root-cause analysis

[Le Merrer, Morgan & Trédan 2021, shadow banning](https://arxiv.org/pdf/2012.05101) · [Ibrahim & Girmay 2026, TikTok visibility audit](https://arxiv.org/pdf/2607.17356) · [Delmonaco et al. 2024, CSCW](https://deepblue.lib.umich.edu/handle/2027.42/192621) · [CloudRCA](https://arxiv.org/abs/2111.03753) · [CIRCA](https://arxiv.org/abs/2206.05871) · [RCA for microservices: how far are we? (ASE 2024)](https://arxiv.org/html/2408.13729v1) · [Bayesian root cause discovery (ICML 2026)](https://icml.cc/virtual/2026/poster/65359)

### Agent engineering

[Anthropic, effective harnesses for long-running agents](https://anthropic.com/engineering/effective-harnesses-for-long-running-agents) · [Anthropic, scaling managed agents](https://anthropic.com/engineering/managed-agents) · [Claude Code best practices](https://www.anthropic.com/engineering/claude-code-best-practices) · [Hooks](https://code.claude.com/docs/en/hooks) · [Subagents](https://code.claude.com/docs/en/sub-agents) · [Sandboxing](https://code.claude.com/docs/en/sandboxing) · [GitHub Actions](https://code.claude.com/docs/en/github-actions) · [GitHub Spec Kit](https://github.com/github/spec-kit) · [Ralph loops (Geocodio)](https://www.geocod.io/code-and-coordinates/2026-01-27-ralph-loops) · [SWE-agent](https://papers.neurips.cc/paper_files/paper/2024/hash/5a7c947568c1b1328ccc5230172e1e7c-Abstract-Conference.html) · [AutoCodeRover](https://arxiv.org/abs/2404.05427v3) · [MetaGPT](https://arxiv.org/abs/2308.00352v5) · [On randomness in agentic evals](https://arxiv.org/html/2602.07150v2) · [Is three the magic number?](https://huggingface.co/papers/2607.05197.md) · [Looping is not reliability](https://www.alphaxiv.org/abs/2607.24604) · [SWE-Bench Pro Verified](https://huggingface.co/papers/2609.08149.md) · [Cursor, reward hacking](https://cursor.com/blog/reward-hacking-coding-benchmarks) · [Warp, agent metrics](https://www.warp.dev/articles/metrics-that-prove-ai-coding-agents-are-working)

### Stack, hosting and billing

[Next.js 16.4](https://nextjs.org/blog/next-16-4) · [TanStack charts comparison](https://tanstack.com/charts/latest/docs/comparison) · [Neon pricing](https://neon.com/pricing) · [Supabase pg\_partman migration](https://supabase.com/docs/guides/database/migrating-to-pg-partman.md) · [Drizzle RLS](https://orm.drizzle.team/docs/rls) · [pg-boss](https://github.com/timgit/pg-boss) · [Inngest pricing](https://www.inngest.com/pricing) · [Trigger.dev pricing](https://trigger.dev/pricing) · [Better Auth generic OAuth](https://www.better-auth.com/docs/plugins/generic-oauth) · [Auth library comparison](https://www.pkgpulse.com/guides/better-auth-vs-lucia-vs-nextauth-2026) · [PDF generation comparison](https://dev.to/iurii_rogulia/pdf-generation-on-the-server-puppeteer-vs-react-pdfrenderer-a-production-comparison-44cg) · [Sentry pricing](https://sentry.io/pricing/) · [Grafana Cloud pricing](https://grafana.com/pricing/) · [Better Stack pricing](https://betterstack.com/pricing) · [PostHog pricing](https://posthog.com/pricing) · [Vercel pricing](https://vercel.com/pricing) · [Railway pricing](https://railway.com/pricing) · [Fly pricing](https://docs.fly.io/about/pricing) · [Hetzner plans (Oct 2026)](https://www.bitdoze.com/hetzner-cloud-cost-optimized-plans/) · [Self-hosted PaaS comparison](https://wz-it.com/en/blog/self-hosted-paas-comparison-coolify-dokploy-caprover/) · [Paddle supported countries](https://www.paddle.com/help/start/account-verification/which-countries-are-supported-by-paddle) · [Lemon Squeezy supported countries](https://docs.lemonsqueezy.com/help/getting-started/supported-countries) · [Paddle vs Lemon Squeezy (Dodo)](https://dodopayments.com/blogs/paddle-vs-lemon-squeezy/) · [Shopify revenue share](https://shopify.dev/docs/apps/launch/distribution/revenue-share.md) · [Shopify webhooks best practices](https://hookdeck.com/webhooks/platforms/shopify-webhooks-best-practices-revised-and-extended) · [GA4 Data API quotas](https://developers.google.com/analytics/devguides/reporting/data/v1/quotas) · [GA4 default channel groups](https://support.google.com/analytics/answer/9756891)

### Competitors, customers and design

[Tailwind pricing](https://www.tailwindapp.com/pricing) · [Tailwind reach-drop post](https://www.tailwindapp.com/blog/pinterest-reach-drop-impressions) · [Tailwind affiliates](https://www.tailwindapp.com/affiliate) · [Tailwind Trustpilot](https://www.trustpilot.com/review/tailwindapp.com) · [PinClicks pricing](https://pinclicks.com/pricing) · [Pin Inspector](https://pininspector.com/) · [PinGenerator pricing](https://pingenerator.com/pricing) · [BlogToPin pricing](https://blogtopin.com/pricing) · [Later pricing](https://later.com/pricing/) · [Metricool pricing](https://metricool.com/pricing/) · [Circleboom shadowban checker](https://circleboom.com/blog/pinterest-shadowban-checker/) · [Pinterest MCP and Business Assistant (ppc.land)](https://ppc.land/pinterests-mcp-server-and-ask-pinterest-app-rewrite-the-discovery-playbook/) · [Pinterest manager tool stack](https://pinningartfully.substack.com/p/all-the-cool-software-i-use-for-my) · [DDIY VA cost 2026](https://ddiy.co/virtual-assistant-pinterest-cost/) · [Boutique COO VA cost](https://theboutiquecoo.squarespace.com/blog/how-much-does-it-cost-to-hire-a-pinterest-va) · [Kristin Larsen course review](https://digitaltriggers.io/pinterest-va-review) · [SPM Insiders](https://www.simplepinmedia.com/spm-insiders/) · [Food Blogger Pro ep. 555](https://www.foodbloggerpro.com/podcast/pinterest-strategy-for-food-creators-in-2026/) · [Ahrefs health score](https://help.ahrefs.com/en/articles/1424673-what-is-health-score-and-how-is-it-calculated-in-ahrefs-site-audit) · [Semrush site audit](https://www.semrush.com/kb/540-site-audit-overview) · [GSC page indexing](https://support.google.com/webmasters/answer/7440203) · [Sentry issues](https://docs.sentry.io/product/issues/) · [Stripe Radar risk insights](https://docs.stripe.com/radar/reviews/risk-insights) · [WCAG 2.2 contrast](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) · [Radix colour scale](https://www.radix-ui.com/colors/docs/palette-composition/understanding-the-scale) · [shadcn charts](https://ui.shadcn.com/docs/components/chart) · [Datawrapper colour guide](https://www.datawrapper.de/blog/colorguide)

### Graph tooling and hashing

[PostgreSQL recursive queries](https://www.postgresql.org/docs/current/queries-with.html) · [Neo4j licensing](https://neo4j.com/licensing/) · [Kuzu acquired by Apple](https://cs.uwaterloo.ca/news/waterloo-based-graph-database-start-up-kuzu-acquired-apple) · [Kuzu archived, LadybugDB](https://oneuptime.com/blog/post/2026-08-12-kuzu-archived-pin-0-11-3-fork-or-migrate/markdown) · [Apache AGE 1.8](https://www.enterprisedb.com/docs/pg_extensions/apache_age/rel_notes/apache_age_1.8.0_rel_notes/) · [DuckPGQ](https://duckdb.org/community_extensions/extensions/duckpgq) · [graph-tool performance](https://graph-tool.skewed.de/performance.html) · [imagehash](https://github.com/JohannesBuchner/imagehash) · [Meta PDQ](https://github.com/facebook/ThreatExchange) · [PDQ test drive](https://arxiv.org/pdf/1912.07745)

Not verifiable this session: exact ad auto-UTM values; GenAI Acceptable Use Guidelines contents; Paddle payout fees for Pakistan; Google's social-sites list for GA4; the existence of PINREVOS.
