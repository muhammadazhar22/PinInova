# PinPulse app image: Next.js web, pg-boss worker, SQL migrations, and (staging in mock mode only) the MOCK
# Pinterest server, all from one pnpm workspace install. Headless Chromium is included for report PDFs.
# Build from the repo root:  docker build -f infra/app.Dockerfile -t pinpulse-app .
#
# Chromium comes from the official Playwright image whose version matches playwright-core in apps/web/package.json
# (1.65.0 -> chromium_headless_shell-1254). Bump PLAYWRIGHT_IMAGE together with playwright-core.
ARG NODE_IMAGE=node:22-bookworm-slim
ARG RUNTIME_IMAGE=ubuntu:24.04
ARG PLAYWRIGHT_IMAGE=mcr.microsoft.com/playwright:v1.65.0-noble

FROM ${PLAYWRIGHT_IMAGE} AS chromium

FROM ${NODE_IMAGE} AS build
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
COPY services/pinterest-mock/package.json services/pinterest-mock/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter web build && rm -rf apps/web/.next/cache

FROM ${NODE_IMAGE} AS node

FROM ${RUNTIME_IMAGE} AS runtime
# Shared libraries headless Chromium needs on Ubuntu 24.04, plus fonts for reports.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates tini fonts-liberation fonts-noto-core fonts-noto-color-emoji \
      libnss3 libnspr4 libatk1.0-0t64 libatk-bridge2.0-0t64 libcups2t64 libdrm2 libdbus-1-3 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2t64 \
      libatspi2.0-0t64 libx11-6 libxcb1 libxext6 libexpat1 libglib2.0-0t64 \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app --home /repo app
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=chromium /ms-playwright/chromium_headless_shell-1254 /opt/chromium
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 \
    CHROME_PATH=/opt/chromium/chrome-headless-shell-linux64/chrome-headless-shell
COPY --from=build --chown=app:app /repo /repo
USER app
WORKDIR /repo/apps/web
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
# Default: web. infra/docker-compose.prod.yml overrides the command for the worker, migrations and the mock.
CMD ["node_modules/.bin/next", "start", "-p", "3000", "-H", "0.0.0.0"]
