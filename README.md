# PinPulse

Pinterest account health, diagnosis and protection. Monorepo seeded from the master plan (see `docs/PLAN.md` link).

```
apps/web                Next.js app (UI, auth, OAuth, billing, jobs)       — TypeScript
services/analytics      Detection/diagnosis engine + FastAPI               — Python 3.11+
packages/shared         zod schemas / JSON Schema shared contracts
infra                   Terraform/SST, Dockerfiles, runbooks
specs                   Feature specs (agents implement from these)
docs                    ADRs, threat model, policy notes, detector log
.claude/skills          Agent skills (detector-loop, review, spec)
```

## Quick start
```
pnpm install
docker compose up -d postgres redis
pnpm dev                      # web on :3000, analytics on :8000
cd services/analytics && pip install -e ".[dev]" && pytest && python -m pinpulse_analytics.benchmark
```

## Status
- [x] Detection core: PELT changepoints on log1p counts, Beta-Binomial rate-shift test, top-Pin decomposition, weather Bayes factor, rule-scored cause classifier
- [x] Synthetic benchmark with frozen ground truth + CI regression gate (`benchmark_baseline.json`)
- [ ] SPEC-001 OAuth connect/disconnect
- [ ] SPEC-002 Nightly sync
- [ ] SPEC-010 CSV import (v0 Drop Check)

## Plan and research
- Master plan (Claude doc): https://claude.ai/artifact/RrVoqRUAVvGGayEDXuSLxP
- Research reports: `docs/research/` (detection methods, Pinterest platform verification, competitors/customers/design, engineering stack & deployment, graph engineering)
