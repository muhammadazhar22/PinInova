/**
 * Query-time aggregation over the per-Pin series. Shapes follow the v5.28.0 OpenAPI schemas:
 * AnalyticsResponse, PinAnalyticsResponse, TopPinsAnalyticsResponse and Pin.pin_metrics.
 */
import { B_IMP, B_OUTBOUND, B_PIN_CLICK, B_SAVE, HISTORY_DAYS, N_BASE, PROCESSING_DAYS, type AccountData, type Dataset, type OrganicPinFormat, type PinRec } from "./data.ts";
import { DAY_MS, formatDay } from "./dates.ts";
import { hashN } from "./rng.ts";

// ---- enums (from the spec) ----
export const ACCOUNT_METRIC_TYPES = [
  "ENGAGEMENT",
  "ENGAGEMENT_RATE",
  "IMPRESSION",
  "OUTBOUND_CLICK",
  "OUTBOUND_CLICK_RATE",
  "PIN_CLICK",
  "PIN_CLICK_RATE",
  "SAVE",
  "SAVE_RATE",
] as const;
export type AccountMetric = (typeof ACCOUNT_METRIC_TYPES)[number];

export const STANDARD_PIN_METRIC_TYPES = ["IMPRESSION", "OUTBOUND_CLICK", "PIN_CLICK", "SAVE", "SAVE_RATE", "TOTAL_COMMENTS", "TOTAL_REACTIONS", "USER_FOLLOW", "PROFILE_VISIT"] as const;
export const VIDEO_PIN_METRIC_TYPES = [
  "IMPRESSION",
  "OUTBOUND_CLICK",
  "PIN_CLICK",
  "SAVE",
  "SAVE_RATE",
  "VIDEO_MRC_VIEW",
  "VIDEO_10S_VIEW",
  "QUARTILE_95_PERCENT_VIEW",
  "VIDEO_V50_WATCH_TIME",
  "VIDEO_START",
  "VIDEO_AVG_WATCH_TIME",
  "TOTAL_COMMENTS",
  "TOTAL_REACTIONS",
] as const;
export const PIN_METRIC_TYPES: readonly string[] = [...new Set<string>([...STANDARD_PIN_METRIC_TYPES, ...VIDEO_PIN_METRIC_TYPES])];

export const SPLIT_FIELDS = ["NO_SPLIT", "APP_TYPE", "OWNED_CONTENT", "SOURCE", "PIN_FORMAT"] as const;
export type SplitField = (typeof SPLIT_FIELDS)[number];
export const APP_TYPES = ["ALL", "MOBILE", "TABLET", "WEB"] as const;
export type AppTypeFilter = (typeof APP_TYPES)[number];
export const PIN_FORMATS = ["ALL", "ORGANIC_IMAGE", "ORGANIC_PRODUCT", "ORGANIC_VIDEO", "ADS_STANDARD", "ADS_PRODUCT", "ADS_VIDEO", "ADS_IDEA"] as const;
export const CONTENT_TYPES = ["ALL", "PAID", "ORGANIC"] as const;
export const SOURCES = ["ALL", "YOUR_PINS", "OTHER_PINS"] as const;
export const FROM_CLAIMED = ["OTHER", "CLAIMED", "BOTH"] as const;
export const TOP_PINS_SORT_BY = ["ENGAGEMENT", "SAVE", "IMPRESSION", "OUTBOUND_CLICK", "PIN_CLICK"] as const;

/**
 * Response keys per split_field. MOCK ASSUMPTION (the spec only says `additionalProperties`):
 * NO_SPLIT uses "all" (as in Pinterest's published examples); every other split uses the values
 * of the matching filter parameter's enum, minus its "everything" value.
 */
export const SPLIT_KEYS: Record<SplitField, readonly string[]> = {
  NO_SPLIT: ["all"],
  APP_TYPE: ["MOBILE", "TABLET", "WEB"],
  OWNED_CONTENT: ["CLAIMED", "OTHER"],
  SOURCE: ["YOUR_PINS", "OTHER_PINS"],
  PIN_FORMAT: ["ORGANIC_IMAGE", "ORGANIC_PRODUCT", "ORGANIC_VIDEO"],
};

export interface AccountFilters {
  appTypes: AppTypeFilter;
  pinFormat: string;
  contentType: string;
  source: string;
  fromClaimed: string;
}

export const DEFAULT_FILTERS: AccountFilters = { appTypes: "ALL", pinFormat: "ALL", contentType: "ALL", source: "ALL", fromClaimed: "BOTH" };

type DataStatus = "READY" | "PROCESSING" | "BEFORE_PIN_CREATED";

export function dataStatusFor(ds: Dataset, day: number): DataStatus {
  return day > ds.today - PROCESSING_DAYS ? "PROCESSING" : "READY";
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

const APP_IDX: Record<string, number> = { MOBILE: 0, TABLET: 1, WEB: 2 };

/** Deterministically split a count into [MOBILE, TABLET, WEB] parts that sum to v. */
export function appSplit(v: number, shares: [number, number, number], h: number): [number, number, number] {
  if (v === 0) return [0, 0, 0];
  const u1 = (h & 0xffff) / 65536;
  const u2 = (h >>> 16) / 65536;
  const m = Math.min(v, Math.floor(v * shares[0] + u1));
  const t = Math.min(v - m, Math.floor(v * shares[1] + u2));
  return [m, t, v - m - t];
}

function appPart(ds: Dataset, acct: AccountData, unit: number, day: number, slot: number, v: number, app: AppTypeFilter): number {
  if (app === "ALL" || v === 0) return v;
  return appSplit(v, acct.appShares, hashN(ds.seed, acct.idx, unit, day, slot))[APP_IDX[app]];
}

// ---------------------------------------------------------------- account analytics

interface Unit {
  key: number; // pin idx, or OTHER_UNIT
  pin: PinRec | null;
  format: OrganicPinFormat;
  claimed: boolean;
  isOther: boolean;
}
const OTHER_UNIT = 1_000_000;

function baseValue(acct: AccountData, unit: Unit, slot: number, o: number): number {
  if (unit.isOther) return acct.other[slot * HISTORY_DAYS + o];
  return acct.series[(unit.key * N_BASE + slot) * HISTORY_DAYS + o];
}

function unitsFor(acct: AccountData, f: AccountFilters, endDay: number): Unit[] {
  if (f.contentType === "PAID") return []; // the mock accounts run no ads
  const units: Unit[] = [];
  if (f.source !== "OTHER_PINS") {
    for (const p of acct.pins) {
      if (p.createdDay > endDay) continue;
      units.push({ key: p.idx, pin: p, format: p.format, claimed: p.claimed, isOther: false });
    }
  }
  if (f.source !== "YOUR_PINS" && acct.hasClaimed) {
    units.push({ key: OTHER_UNIT, pin: null, format: "ORGANIC_IMAGE", claimed: true, isOther: true });
  }
  return units.filter((u) => {
    if (f.pinFormat !== "ALL" && u.format !== f.pinFormat) return false;
    if (f.fromClaimed === "CLAIMED" && !u.claimed) return false;
    if (f.fromClaimed === "OTHER" && u.claimed) return false;
    return true;
  });
}

function groupOf(split: SplitField, u: Unit): string {
  switch (split) {
    case "OWNED_CONTENT":
      return u.claimed ? "CLAIMED" : "OTHER";
    case "SOURCE":
      return u.isOther ? "OTHER_PINS" : "YOUR_PINS";
    case "PIN_FORMAT":
      return u.format;
    default:
      return "all";
  }
}

function accountMetricValues(b: Float64Array | number[], off: number, metrics: readonly string[]): Record<string, number> {
  const imp = b[off + B_IMP];
  const save = b[off + B_SAVE];
  const click = b[off + B_PIN_CLICK];
  const out = b[off + B_OUTBOUND];
  const eng = save + click + out;
  const r = (x: number) => (imp > 0 ? round6(x / imp) : 0);
  const res: Record<string, number> = {};
  for (const m of metrics) {
    switch (m) {
      case "IMPRESSION": res[m] = imp; break;
      case "SAVE": res[m] = save; break;
      case "PIN_CLICK": res[m] = click; break;
      case "OUTBOUND_CLICK": res[m] = out; break;
      case "ENGAGEMENT": res[m] = eng; break;
      case "ENGAGEMENT_RATE": res[m] = r(eng); break;
      case "SAVE_RATE": res[m] = r(save); break;
      case "PIN_CLICK_RATE": res[m] = r(click); break;
      case "OUTBOUND_CLICK_RATE": res[m] = r(out); break;
    }
  }
  return res;
}

export interface AccountAnalyticsQuery {
  startDay: number;
  endDay: number;
  metrics: readonly string[];
  split: SplitField;
  filters: AccountFilters;
}

/** Raw per-group per-day base totals; exported for tests and for top-level consistency checks. */
export function accountBaseTotals(ds: Dataset, acct: AccountData, q: Omit<AccountAnalyticsQuery, "metrics">): { days: number[]; groups: Map<string, Float64Array> } {
  const last = Math.min(q.endDay, ds.today);
  const days: number[] = [];
  for (let d = Math.max(q.startDay, ds.firstDay); d <= last; d++) days.push(d);
  const groups = new Map<string, Float64Array>();
  for (const k of SPLIT_KEYS[q.split]) groups.set(k, new Float64Array(days.length * N_BASE));
  const units = unitsFor(acct, q.filters, last);
  const app = q.filters.appTypes;
  for (const u of units) {
    const target = q.split === "APP_TYPE" ? null : groups.get(groupOf(q.split, u))!;
    for (let di = 0; di < days.length; di++) {
      const day = days[di];
      if (u.pin && day < u.pin.createdDay) continue;
      const o = day - ds.firstDay;
      for (let s = 0; s < N_BASE; s++) {
        const v = baseValue(acct, u, s, o);
        if (v === 0) continue;
        if (target) {
          target[di * N_BASE + s] += appPart(ds, acct, u.key, day, s, v, app);
        } else {
          const parts = appSplit(v, acct.appShares, hashN(ds.seed, acct.idx, u.key, day, s));
          if (app === "ALL") {
            groups.get("MOBILE")![di * N_BASE + s] += parts[0];
            groups.get("TABLET")![di * N_BASE + s] += parts[1];
            groups.get("WEB")![di * N_BASE + s] += parts[2];
          } else {
            groups.get(app)![di * N_BASE + s] += parts[APP_IDX[app]];
          }
        }
      }
    }
  }
  return { days, groups };
}

export function accountAnalytics(ds: Dataset, acct: AccountData, q: AccountAnalyticsQuery): Record<string, unknown> {
  const { days, groups } = accountBaseTotals(ds, acct, q);
  const out: Record<string, unknown> = {};
  for (const [key, b] of groups) {
    const totals = [0, 0, 0, 0];
    const daily = days.map((day, di) => {
      for (let s = 0; s < N_BASE; s++) totals[s] += b[di * N_BASE + s];
      return { date: formatDay(day), data_status: dataStatusFor(ds, day), metrics: accountMetricValues(b, di * N_BASE, q.metrics) };
    });
    out[key] = { daily_metrics: daily, summary_metrics: accountMetricValues(totals, 0, q.metrics) };
  }
  return out;
}

// ---------------------------------------------------------------- Pin-level metrics

/** Count-type Pin metrics (summable). Ratio metrics are derived from these. */
const PIN_COUNT_SLOTS = [
  "IMPRESSION",
  "SAVE",
  "PIN_CLICK",
  "OUTBOUND_CLICK",
  "TOTAL_REACTIONS",
  "TOTAL_COMMENTS",
  "PROFILE_VISIT",
  "USER_FOLLOW",
  "VIDEO_START",
  "VIDEO_MRC_VIEW",
  "VIDEO_10S_VIEW",
  "QUARTILE_95_PERCENT_VIEW",
  "VIDEO_V50_WATCH_TIME",
] as const;
const NC = PIN_COUNT_SLOTS.length;
const SLOT: Record<string, number> = Object.fromEntries(PIN_COUNT_SLOTS.map((m, i) => [m, i]));

function u01(ds: Dataset, acct: AccountData, pin: PinRec, day: number, k: number): number {
  return hashN(ds.seed, acct.idx, pin.idx, day, 100 + k) / 4294967296;
}

/** All count metrics for one Pin-day (before any device split). */
function pinDayCounts(ds: Dataset, acct: AccountData, pin: PinRec, day: number, out: Float64Array, off: number): void {
  const o = day - ds.firstDay;
  const base = (pin.idx * N_BASE) * HISTORY_DAYS + o;
  const imp = acct.series[base + B_IMP * HISTORY_DAYS];
  const save = acct.series[base + B_SAVE * HISTORY_DAYS];
  const click = acct.series[base + B_PIN_CLICK * HISTORY_DAYS];
  const outb = acct.series[base + B_OUTBOUND * HISTORY_DAYS];
  out[off + 0] = imp;
  out[off + 1] = save;
  out[off + 2] = click;
  out[off + 3] = outb;
  out[off + 4] = Math.floor(save * 0.3 + u01(ds, acct, pin, day, 4));
  out[off + 5] = Math.floor(save * 0.05 + u01(ds, acct, pin, day, 5));
  const pv = Math.floor(click * 0.12 + u01(ds, acct, pin, day, 6));
  out[off + 6] = pv;
  out[off + 7] = Math.floor(pv * 0.1 + u01(ds, acct, pin, day, 7));
  if (pin.format === "ORGANIC_VIDEO") {
    out[off + 8] = Math.floor(imp * 0.35 + u01(ds, acct, pin, day, 8));
    const mrc = Math.floor(imp * 0.2 + u01(ds, acct, pin, day, 9));
    out[off + 9] = mrc;
    out[off + 10] = Math.floor(imp * 0.08 + u01(ds, acct, pin, day, 10));
    out[off + 11] = Math.floor(imp * 0.03 + u01(ds, acct, pin, day, 11));
    out[off + 12] = Math.round(mrc * (2500 + 1500 * u01(ds, acct, pin, day, 12)));
  } else {
    for (let k = 8; k < NC; k++) out[off + k] = 0;
  }
}

function pinMetricValues(b: Float64Array | number[], off: number, metrics: readonly string[]): Record<string, number> {
  const res: Record<string, number> = {};
  for (const m of metrics) {
    if (m === "SAVE_RATE") {
      const imp = b[off + SLOT.IMPRESSION];
      res[m] = imp > 0 ? round6(b[off + SLOT.SAVE] / imp) : 0;
    } else if (m === "VIDEO_AVG_WATCH_TIME") {
      const starts = b[off + SLOT.VIDEO_START];
      res[m] = starts > 0 ? Math.round((b[off + SLOT.VIDEO_V50_WATCH_TIME] / starts) * 100) / 100 : 0;
    } else {
      res[m] = b[off + SLOT[m]];
    }
  }
  return res;
}

export interface PinAnalyticsQuery {
  startDay: number;
  endDay: number;
  metrics: readonly string[];
  split: "NO_SPLIT" | "APP_TYPE";
  appTypes: AppTypeFilter;
}

export function pinAnalytics(ds: Dataset, acct: AccountData, pin: PinRec, q: PinAnalyticsQuery): Record<string, unknown> {
  const last = Math.min(q.endDay, ds.today);
  const days: number[] = [];
  for (let d = Math.max(q.startDay, ds.firstDay); d <= last; d++) days.push(d);
  const keys = q.split === "APP_TYPE" ? ["MOBILE", "TABLET", "WEB"] : ["all"];
  const groups = new Map(keys.map((k) => [k, new Float64Array(days.length * NC)]));
  const tmp = new Float64Array(NC);
  for (let di = 0; di < days.length; di++) {
    const day = days[di];
    if (day < pin.createdDay) continue;
    pinDayCounts(ds, acct, pin, day, tmp, 0);
    for (let s = 0; s < NC; s++) {
      const v = tmp[s];
      if (v === 0) continue;
      // Same hash slots as accountBaseTotals for the 4 base metrics, so device splits add up.
      const parts = appSplit(v, acct.appShares, hashN(ds.seed, acct.idx, pin.idx, day, s < N_BASE ? s : 50 + s));
      if (q.split === "APP_TYPE") {
        if (q.appTypes === "ALL") {
          groups.get("MOBILE")![di * NC + s] += parts[0];
          groups.get("TABLET")![di * NC + s] += parts[1];
          groups.get("WEB")![di * NC + s] += parts[2];
        } else {
          groups.get(q.appTypes)![di * NC + s] += parts[APP_IDX[q.appTypes]];
        }
      } else {
        groups.get("all")![di * NC + s] += q.appTypes === "ALL" ? v : parts[APP_IDX[q.appTypes]];
      }
    }
  }
  const lifetimeWanted = q.metrics.filter((m) => m === "TOTAL_COMMENTS" || m === "TOTAL_REACTIONS");
  const lifetime = lifetimeWanted.length ? pinLifetimeCounts(ds, acct, pin) : null;
  const out: Record<string, unknown> = {};
  for (const [key, b] of groups) {
    const totals = new Float64Array(NC);
    const daily = days.map((day, di) => {
      if (day < pin.createdDay) return { date: formatDay(day), data_status: "BEFORE_PIN_CREATED", metrics: {} };
      for (let s = 0; s < NC; s++) totals[s] += b[di * NC + s];
      return { date: formatDay(day), data_status: dataStatusFor(ds, day), metrics: pinMetricValues(b, di * NC, q.metrics) };
    });
    const entry: Record<string, unknown> = { daily_metrics: daily, summary_metrics: pinMetricValues(totals, 0, q.metrics) };
    if (lifetime) {
      const lm: Record<string, number> = {};
      for (const m of lifetimeWanted) lm[m] = lifetime[SLOT[m]];
      entry.lifetime_metrics = lm;
    }
    out[key] = entry;
  }
  return out;
}

function pinLifetimeCounts(ds: Dataset, acct: AccountData, pin: PinRec, fromDay = pin.createdDay): Float64Array {
  const totals = new Float64Array(NC);
  const tmp = new Float64Array(NC);
  for (let d = Math.max(fromDay, pin.createdDay, ds.firstDay); d <= ds.today; d++) {
    pinDayCounts(ds, acct, pin, d, tmp, 0);
    for (let s = 0; s < NC; s++) totals[s] += tmp[s];
  }
  return totals;
}

/** Pin.pin_metrics when `pin_metrics=true` (keys follow the spec's example). */
export function pinMetricsObject(ds: Dataset, acct: AccountData, pin: PinRec): Record<string, Record<string, number>> {
  const life = pinLifetimeCounts(ds, acct, pin);
  const d90 = pinLifetimeCounts(ds, acct, pin, ds.today - 89);
  return {
    "90d": { pin_click: d90[SLOT.PIN_CLICK], impression: d90[SLOT.IMPRESSION], clickthrough: d90[SLOT.OUTBOUND_CLICK] },
    lifetime_metrics: {
      pin_click: life[SLOT.PIN_CLICK],
      impression: life[SLOT.IMPRESSION],
      clickthrough: life[SLOT.OUTBOUND_CLICK],
      reaction: life[SLOT.TOTAL_REACTIONS],
      comment: life[SLOT.TOTAL_COMMENTS],
    },
  };
}

// ---------------------------------------------------------------- top pins

export interface TopPinsQuery {
  startDay: number;
  endDay: number;
  sortBy: string;
  metrics: readonly string[];
  numOfPins: number;
  createdInLastNDays: number | null;
  filters: AccountFilters;
}

export function topPins(ds: Dataset, acct: AccountData, q: TopPinsQuery): Record<string, unknown> {
  const last = Math.min(q.endDay, ds.today);
  const filters = { ...q.filters, source: q.filters.source === "ALL" ? "YOUR_PINS" : q.filters.source };
  const units = unitsFor(acct, filters, last).filter((u) => !u.isOther);
  const minCreated = q.createdInLastNDays ? ds.today - (q.createdInLastNDays - 1) : -Infinity;
  const rows: { pin: PinRec; b: number[] }[] = [];
  for (const u of units) {
    const pin = u.pin!;
    if (pin.createdDay < minCreated) continue;
    const b = [0, 0, 0, 0];
    for (let d = Math.max(q.startDay, pin.createdDay, ds.firstDay); d <= last; d++) {
      const o = d - ds.firstDay;
      for (let s = 0; s < N_BASE; s++) {
        const v = acct.series[(pin.idx * N_BASE + s) * HISTORY_DAYS + o];
        if (v) b[s] += appPart(ds, acct, pin.idx, d, s, v, filters.appTypes);
      }
    }
    rows.push({ pin, b });
  }
  const sortVal = (r: { b: number[] }) => accountMetricValues(r.b, 0, [q.sortBy])[q.sortBy];
  rows.sort((a, z) => sortVal(z) - sortVal(a) || (a.pin.id < z.pin.id ? -1 : 1));
  const metrics = q.metrics.includes(q.sortBy) ? q.metrics : [...q.metrics, q.sortBy];
  const status = last > ds.today - PROCESSING_DAYS ? "PROCESSING" : "READY";
  const latestReadyDay = ds.today - PROCESSING_DAYS;
  return {
    date_availability: { is_realtime: last > latestReadyDay, latest_available_timestamp: (latestReadyDay + 1) * DAY_MS - 1000 },
    pins: rows.slice(0, q.numOfPins).map((r) => ({
      pin_id: r.pin.id,
      metrics: accountMetricValues(r.b, 0, metrics),
      data_status: Object.fromEntries(metrics.map((m) => [m, status])),
    })),
    sort_by: q.sortBy,
  };
}

// ---------------------------------------------------------------- helpers used by tests / admin

/** YOUR_PINS impressions per day for one Pin (no device split), for quick checks. */
export function pinDailySeries(ds: Dataset, acct: AccountData, pin: PinRec, slot = B_IMP): Int32Array {
  const start = (pin.idx * N_BASE + slot) * HISTORY_DAYS;
  return acct.series.subarray(start, start + HISTORY_DAYS);
}
