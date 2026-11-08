/**
 * Starts the MOCK websites server and the MOCK Pinterest API server.
 *   pnpm --dir services/pinterest-mock start
 * Config via env: see README.md.
 */
import { resolveServerConfig, resolveSitePort } from "./config.ts";
import { createMockServer } from "./server.ts";
import { createMockSites } from "./sites.ts";

async function main(): Promise<void> {
  const sites = await createMockSites({ port: resolveSitePort() });
  const cfg = resolveServerConfig();
  const siteBase = process.env.MOCK_SITE_BASE ?? sites.url;
  const api = await createMockServer({ siteBase });
  const today = cfg.fixedToday === null ? "current UTC date" : process.env.MOCK_TODAY;
  process.stderr.write(
    [
      "",
      "  ==============================================================",
      "   MOCK Pinterest API v5 — NOT the real Pinterest. Synthetic data.",
      "  ==============================================================",
      `   API        ${api.url}/v5`,
      `   OAuth      ${api.url}/oauth/`,
      `   Admin      ${api.url}/__mock/state   ${api.url}/__mock/accounts`,
      `   Sites      ${sites.url}   (Pin links use ${siteBase})`,
      `   seed=${cfg.seed} today=${today} client_id=${cfg.clientId} auto_consent=${cfg.autoConsent}`,
      `   rate limits/min: org_analytics=${cfg.rateAnalyticsPerMin} org_read=${cfg.rateReadPerMin} fault_rate=${cfg.faultRate}`,
      "",
    ].join("\n") + "\n",
  );
  const shutdown = async () => {
    await Promise.allSettled([api.close(), sites.close()]);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  process.stderr.write(`[MOCK pinterest] failed to start: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
