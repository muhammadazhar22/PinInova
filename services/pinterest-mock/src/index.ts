/**
 * @pinpulse/pinterest-mock — MOCK Pinterest API v5 + mock websites.
 * NOT Pinterest. All accounts and data are synthetic. See README.md.
 */
export { createMockServer, PINNER_DATA_ACCESS_DENIED, type RunningMock } from "./server.ts";
export { createMockSites, robotsTxt, type SiteRequestLog } from "./sites.ts";
export type { MockServerOptions, MockSitesOptions } from "./config.ts";
export { ACCOUNTS, SITES, DEFAULT_AUTO_CONSENT_USER, type AccountDef, type SiteDef, type ScenarioId } from "./catalog.ts";
export { SPLIT_KEYS, ACCOUNT_METRIC_TYPES, PIN_METRIC_TYPES } from "./metrics.ts";
export { getDataset } from "./data.ts";
