---
id: SPEC-078
title: Local development on Windows (WSL2)
status: in-progress
owner: founder
risk: low   # local-dev config, docs, startup parsing of blank env values, PDF browser relaunch
spec_version: 1
---

## Why
The founder runs PinInova on Windows 11 in WSL2 (Ubuntu) with Docker Desktop. Following the README there hit five
problems, each worked around by hand in `.env.local`:

1. Windows reserves port ranges that a Windows browser can't reach (on the founder's machine 3980-4079, covering the
   mock's 4010 and 4011), so the mock OAuth consent page never loaded.
2. The mock listened on 127.0.0.1 only; the Windows browser reached `localhost` over IPv6 (`::1`).
3. `PINTEREST_OAUTH_BASE` used 127.0.0.1, which the browser opens; `localhost` works.
4. `.env.example` copied unchanged did not start: blank placeholders (`SENTRY_DSN=`, `SUPPORT_EMAIL=`,
   `REFUND_WINDOW_DAYS=`) failed validation, and `CHROME_PATH=` overrode the Chrome default with "".
5. After Chrome was installed, report PDFs kept failing with HTTP 500 until the app restarted: the failed Chrome
   launch was cached for the life of the process.

## Acceptance criteria
- [x] `.env.example` uses `MOCK_PORT=4410`, `PINTEREST_API_BASE=http://127.0.0.1:4410/v5`,
      `PINTEREST_OAUTH_BASE=http://localhost:4410/oauth/` and `MOCK_HOST=::`.
- [x] Built-in defaults stay 4010 / 127.0.0.1 (mock, `env.ts`), so tests, CI and the staging/prod compose files are unchanged.
- [x] `scripts/dev-stack.sh` waits for the mock on `MOCK_PORT` (fallback 4010) instead of a fixed 4010.
- [x] Local `docker-compose.yml` publishes the mock on host ports 4410/4411.
- [x] An empty env value counts as unset: defaults and optionals apply (`env.ts`). Test: `.env.example` copied unchanged
      parses; blank `SENTRY_DSN`/`SUPPORT_EMAIL`/`REFUND_WINDOW_DAYS` are unset and blank `CHROME_PATH` gives the default.
- [x] Production still refuses blank required secrets (they fall back to dev defaults, which the guard rejects). Test.
- [x] A failed Chrome launch is not cached; the next PDF request launches again. Test.
- [x] Playwright uses the same Chrome default as the app (`/usr/bin/google-chrome`) when `CHROME_PATH` is unset or blank.
- [x] README has a "Windows (WSL2)" section: ports (with the `netsh.exe` command to list reserved ranges),
      localhost/IPv6, installing Chrome in WSL, the `NODE_OPTIONS` workaround for npm timeouts, `--prod` when `next dev`
      keeps reloading, and editing `.env.local` in place instead of appending.
- [x] Follow-up: with `MOCK_HOST=::` the mock advertised `http://[::]:4410` in image URLs, so the web app's image
      fetch (allowed only from the `PINTEREST_API_BASE` host) rejected every Pin image and duplicate-image detection found
      nothing (`mock_new_pins_zero` scored content integrity 100). Wildcard binds (`::`, `0.0.0.0`) now advertise
      `http://127.0.0.1:<port>` for the API and the mock websites. Test: `services/pinterest-mock/test/listen-host.test.ts`.
- [x] Follow-up: the mock kept tokens in memory, so every restart of `scripts/dev-stack.sh` silently invalidated
      every connected mock account (link checks then failed with 401). `MOCK_STATE_FILE` persists access/refresh
      tokens and revocations; `dev-stack.sh` sets `.dev/mock-oauth.json` (git-ignored). Unset = memory only (tests, CI).
      Test: `services/pinterest-mock/test/oauth-persist.test.ts`.
- [x] Gate: web typecheck + unit/RLS tests, `scripts/test-e2e.sh`, `scripts/test-browser.sh`.

## Out of scope
Why `next dev` reload-loops on WSL (not investigated; `--prod` is the documented workaround). Changing the mock's
built-in port or the staging/prod compose files. Running the stack natively on Windows without WSL.

## Data & policy
No data, Pinterest API, OAuth scope or policy-text change. The mock stays labelled as mock. `MOCK_HOST=::` makes the
local mock listen on all interfaces; it serves synthetic data only.
