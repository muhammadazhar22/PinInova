import { defineConfig } from "@playwright/test";

/** Browser e2e. Expects web (3000), worker, mock Pinterest (4010/4011) and analytics (8000) running — see scripts/test-browser.sh. */
export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  use: {
    baseURL: process.env.APP_URL ?? "http://localhost:3000",
    // Only for the local compose smoke test (infra/test-stack.sh), where Caddy serves a locally signed certificate.
    ignoreHTTPSErrors: process.env.E2E_IGNORE_HTTPS_ERRORS === "true",
    launchOptions: { executablePath: process.env.CHROME_PATH || undefined },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: [["list"]],
});
