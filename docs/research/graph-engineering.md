# Graph engineering for PinPulse — research report (7 Nov 2026)

## Verdict

**Graph engineering: NOT required as infrastructure; USEFUL as a modelling lens; a graph database is NOT justified at v1 or v2.**

| Part of PinPulse | Graph needed? | What to actually build |
|---|---|---|
| Cause A (domain/link enforcement) | Graph concept (Pin→domain star), no graph engine | `GROUP BY domain` drop ratios in Postgres |
| Cause B (quality down-ranking) | No | Per-Pin/age-stratified metric trends, SQL window functions |
| Cause C (behavioural: duplicates, same-URL, bulk) | Yes, small — near-duplicate clustering is a genuine graph problem (union-find over pHash matches) | numpy Hamming matrix + union-find in the Python worker (<1 s for 5k Pins) |
| Cause D (platform-wide incident) | Would need cross-account graph → policy-blocked | Own canary accounts + public incident signals only |
| Cause E (seasonality/decay) | No | Time-series per Pin cohort |
| Diagnosis classifier | Not a graph DB; a hand-specified causal DAG is a reasonable v2 | v1: rule scores + logistic regression; v2: knowledge-informed Bayesian network once labels exist |
| Cross-account "weather"/related-accounts | Technically valuable, forbidden without Pinterest's written authorization | Do not build on user data |

Pinterest's own distribution and enforcement systems are graph-driven, so thinking in graphs tells you which signals to compute. But inside one account's data (≤5,000 Pins, a few hundred boards, tens–hundreds of domains) every graph you can legally build is tiny, shallow (1–2 hops), and star-shaped. Postgres joins and ~50 lines of NetworkX/numpy cover it. Neo4j/Memgraph/AGE/Kuzu would add operational cost with zero analytical gain.

## 1. What Pinterest's published systems reveal

- **PinSage (KDD 2018)** — GCN over the pin–board bipartite graph (3B nodes, 18B edges); neighbourhoods by random-walk visit counts. Creator-influenceable: board placement and saves by others (each save adds a Pin–board edge). https://arxiv.org/abs/1806.01973
- **Pixie (WWW 2018)** — random walks with pruning: high-entropy (broad) boards removed with all their edges; very-high-degree Pins' degree reduced; mis-categorised Pin–board edges discarded; "smaller boards tend to be more topically focused". Creator-influenceable: topical coherence of boards, avoiding catch-all boards. https://arxiv.org/pdf/1711.07601.pdf
- **PinnerSage (KDD 2020)** — users as clusters of PinSage embeddings over 60–90 days; retrieval samples medoids. Explains why reach is topical and bursty. https://arxiv.org/abs/2007.03634
- **Spam label propagation** — user–domain bipartite graph; "our model learns to classify a domain as spam rather than a link"; "We apply the same enforcement to all Pins with links belonging to the same domain." Direct justification for Cause A being a per-domain test. https://medium.com/pinterest-engineering/how-pinterest-fights-spam-using-machine-learning-d0ee2589f00a
- **SEINE (SIGIR 2022)** — rGCN over users and domains; edge feature = proportion of a user's interactions with a domain; user–user edges via shared IP and shared content; shared-IP pairs are both spammers with probability 0.97. Creator-influenceable: domain concentration, avoiding shared templates/images across accounts, not sharing IPs across many accounts (agency relevance). https://arxiv.org/abs/2207.10767
- **Near-duplicate image detection** — ~900M clusters over 8B images; feed and search de-duplication; canonical Pin selection (+9% engagement): only one representative of a duplicate cluster is shown. Re-posting one image to many boards/URLs starves the copies. https://arxiv.org/pdf/2209.08433 ; Pin cohesion (image↔landing-page match as a ranking signal): https://medium.com/pinterest-engineering/building-pin-cohesion-229c19fc617e

Four creator-side levers, all computable from one account: board placement/coherence, saves from others, domain concentration, duplicate image signatures.

## 2. The compliant single-account graph

Graph buildable from one account via API v5: Pin → board (→ section), Pin → URL → registered domain, Pin → image-hash cluster, Pin → publish-date bucket, plus 90-day daily metrics. A star-of-stars; max useful path length 2 hops.

| Analysis | Method | Complexity | Tool |
|---|---|---|---|
| Per-domain / per-board drop ratio (A/B) | `GROUP BY domain` over pre/post windows vs account ratio | O(N) | Postgres |
| Age-stratified drops (B vs E) | window functions over publish-date cohorts | O(N log N) | Postgres |
| Same-URL repetition with time edges (C) | `GROUP BY url`, `LAG(created_at)` gaps, counts per 24h/7d | O(N log N) | Postgres |
| Board dilution (Pixie logic) | Pins per board per day; distinct domains per board | O(N) | Postgres |
| Bulk upload bursts | Pins per hour/day, z-score | O(N) | Postgres |
| Near-duplicate clusters (C) | pHash per image; pairwise Hamming (12.5M comparisons at N=5,000, vectorised, <1 s); union-find | O(N²) vectorised | Python worker (numpy, scipy.sparse.csgraph or NetworkX) |

No recursive CTEs needed (fixed 1–2 hop joins). No graph database: NetworkX runs PageRank on a 40k-node graph in ~1.5 s; per-account graphs are 10× smaller. Normalise `domain` with the public-suffix list so subdomains group as Pinterest enforces.

## 3. Cross-account graphs: policy boundary

Valuable per Le Merrer et al. 2021 (banned accounts cluster in the interaction graph) and SEINE. But the Developer Guidelines prohibit combining account information, benchmarking/platform insights without written authorization, and scraping; apps registered on/after 14 Sep 2026 get 403 on non-owned Pins/boards. Must not do without authorization: aggregated weather index on user data; "related accounts hit together"; linking agency clients by shared domain/IP/template. Could do: a written authorization request for an anonymised incident indicator; own-history comparison; Cause D from non-user sources (canary accounts, announcements). An agency owning several accounts is still "other people's accounts" under the wording as fetched; confirm with Pinterest before multi-account views.

## 4. Causal DAG vs rule scores

- CloudRCA (Alibaba, CIKM 2021): knowledge-informed hierarchical Bayesian network; removing predefined knowledge dropped F1 from 0.65–0.78 to 0.47–0.66. https://arxiv.org/abs/2111.03753
- CIRCA (KDD 2022): graph from architecture knowledge and causal assumptions, not learned; +25% top-1 recall. https://arxiv.org/abs/2206.05871
- "RCA for Microservices based on Causal Inference: How Far Are We?" (ASE 2024): 21 RCA methods; learned causal discovery mostly performed like random; simple statistical baselines among the best. https://arxiv.org/html/2408.13729v1
- Bayesian Root Cause Discovery (ICML 2026): needs many pre-failure observations; research-grade. https://icml.cc/virtual/2026/poster/65359

Verdict: v1 rule scores → logistic regression; v2 hand-specified Bayesian network (pgmpy) with CPTs updated from labels, triggered at a few hundred labelled diagnoses. Never learn causal structure from 90-day series.

## 5. Graph tooling (Nov 2026)

Neo4j (GPL/commercial), Memgraph (BSL), Kuzu (archived Oct 2025 after Apple acquisition; LadybugDB and RyuGraph forks), Apache AGE 1.8 (PG18 via EDB), DuckPGQ (CWI research extension), NetworkX/igraph/graph-tool, PyG (needs many labelled graphs). Recommendation: Postgres + numpy/scipy + optional NetworkX.

## 6. Perceptual hashing

imagehash (pHash/dHash 64-bit, Hamming ≈ 6–10 for re-uploads), Meta PDQ (256-bit, ≤30 Hamming; weak to crops >5% and rotations >5°; ~0.08 s/image). Store hash and cluster id, never image bytes. Compliance flag: a hash is derived, non-reversible, but still "information" under a strict reading of the storage clause; compute transiently and persist only cluster membership until Pinterest answers in writing; show Pin ids/links, never re-hosted images.

## Sources

PinSage https://arxiv.org/abs/1806.01973 · Pixie https://arxiv.org/pdf/1711.07601.pdf · PinnerSage https://arxiv.org/abs/2007.03634 · Spam ML https://medium.com/pinterest-engineering/how-pinterest-fights-spam-using-machine-learning-d0ee2589f00a · SEINE https://arxiv.org/abs/2207.10767 · Near-dup https://arxiv.org/pdf/2209.08433 · Pin cohesion https://medium.com/pinterest-engineering/building-pin-cohesion-229c19fc617e · Developer Guidelines https://policy.pinterest.com/en/developer-guidelines · PINNER_DATA_ACCESS_DENIED https://community.pinterest.biz/t/understanding-the-pinner-data-access-denied-access-error/51738 · Le Merrer et al. https://arxiv.org/abs/2012.05101 · CloudRCA https://arxiv.org/abs/2111.03753 · CIRCA https://arxiv.org/abs/2206.05871 · ASE 2024 RCA https://arxiv.org/html/2408.13729v1 · ICML 2026 https://icml.cc/virtual/2026/poster/65359 · PostgreSQL recursive https://www.postgresql.org/docs/current/queries-with.html · Neo4j licensing https://neo4j.com/licensing/ · Kuzu/Apple https://cs.uwaterloo.ca/news/waterloo-based-graph-database-start-up-kuzu-acquired-apple · Kuzu archived https://oneuptime.com/blog/post/2026-08-12-kuzu-archived-pin-0-11-3-fork-or-migrate/markdown · AGE 1.8 https://www.enterprisedb.com/docs/pg_extensions/apache_age/rel_notes/apache_age_1.8.0_rel_notes/ · DuckPGQ https://duckdb.org/community_extensions/extensions/duckpgq · graph-tool https://graph-tool.skewed.de/performance.html · imagehash https://github.com/JohannesBuchner/imagehash · PDQ https://github.com/facebook/ThreatExchange · PDQ test drive https://arxiv.org/pdf/1912.07745
