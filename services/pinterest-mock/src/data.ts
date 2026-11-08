/**
 * Deterministic synthetic dataset. MOCK data only: nothing here is real Pinterest data.
 *
 * Everything is a pure function of (seed, today). Per-Pin daily base metrics are stored in one
 * Int32Array per account; every account-level number the API returns is computed by summing
 * those per-Pin series (plus a small separate "other people's Pins" component), so per-Pin
 * analytics always add up to account analytics for the YOUR_PINS portion.
 */
import { ACCOUNTS, SITE_BY_SLUG, type AccountDef, type AccountDomain, type SiteDef } from "./catalog.ts";
import { DAY_MS, weekday } from "./dates.ts";
import { Rng, hashN, unitHash } from "./rng.ts";

export const HISTORY_DAYS = 730;
/** Base metric slots stored per Pin per day. */
export const B_IMP = 0;
export const B_SAVE = 1;
export const B_PIN_CLICK = 2;
export const B_OUTBOUND = 3;
export const N_BASE = 4;

/** Fraction of a day's final numbers already accumulated, by lag (0 = MOCK_TODAY). */
export const LAG_FRACTIONS: Record<number, number> = { 0: 0.25, 1: 0.7 };
/** Days (counting back from MOCK_TODAY, inclusive) that are still PROCESSING. */
export const PROCESSING_DAYS = 2;

export type OrganicPinFormat = "ORGANIC_IMAGE" | "ORGANIC_VIDEO" | "ORGANIC_PRODUCT";

export interface PinRec {
  id: string;
  idx: number;
  createdDay: number;
  createdAt: string;
  boardIdx: number;
  title: string;
  description: string;
  altText: string | null;
  /** Path on the mock sites server, e.g. "/cozy-kitchen/easy-pasta-recipe-p10003"; null = no link. */
  linkPath: string | null;
  domainSlug: string | null;
  /** Whether the link points at a claimed (verified) website of the account. */
  claimed: boolean;
  format: OrganicPinFormat;
  imageId: number;
  imageVariant: number;
  dominantColor: string;
  isViral: boolean;
  isDuplicate: boolean;
}

export interface BoardRec {
  id: string;
  idx: number;
  name: string;
  description: string;
  createdDay: number;
  followerCount: number;
  pinIdxs: number[];
}

export interface AccountData {
  def: AccountDef;
  idx: number;
  id: string;
  pins: PinRec[];
  boards: BoardRec[];
  /** [(pinIdx * N_BASE + metric) * HISTORY_DAYS + dayOffset] */
  series: Int32Array;
  /** "Other people's Pins" of this account's claimed content: [metric * HISTORY_DAYS + dayOffset] */
  other: Int32Array;
  /** Device shares [MOBILE, TABLET, WEB]. */
  appShares: [number, number, number];
  hasClaimed: boolean;
  profileImageId: number;
}

export interface Dataset {
  seed: number;
  today: number;
  firstDay: number;
  accounts: AccountData[];
  byUsername: Map<string, AccountData>;
  pinIndex: Map<string, { account: AccountData; pin: PinRec }>;
  /** image key for /__img/<key>.png -> (imageId, variant) */
  images: Map<string, { imageId: number; variant: number }>;
}

const cache = new Map<string, Dataset>();

export function getDataset(seed: number, today: number): Dataset {
  const key = `${seed}:${today}`;
  let ds = cache.get(key);
  if (!ds) {
    ds = generate(seed, today);
    if (cache.size > 8) cache.clear();
    cache.set(key, ds);
  }
  return ds;
}

export function clearDatasetCache(): void {
  cache.clear();
}

const SEASON = [1.12, 1.0, 0.97, 0.95, 0.96, 0.92, 1.08]; // Sun..Sat

function lifeCurve(age: number): number {
  if (age < 0) return 0;
  return (1 - Math.exp(-(age + 1) / 4)) * (0.2 + 0.8 * Math.exp(-age / 90));
}

function titleCase(words: string): string {
  return words
    .split(" ")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export function slugifyWords(words: string): string {
  return words.trim().toLowerCase().replace(/\s+/g, "-");
}

/** Inverse of the link-path scheme: "/slug/[old/|slow/]easy-pasta-recipe-p10003" -> "Easy Pasta Recipe". */
export function titleFromPathSegment(segment: string): string {
  const base = segment.replace(/-p\d+$/, "");
  return titleCase(base.split("-").join(" "));
}

function pickWeighted(rng: Rng, domains: AccountDomain[]): AccountDomain {
  let r = rng.float();
  for (const d of domains) {
    r -= d.weight;
    if (r < 0) return d;
  }
  return domains[domains.length - 1];
}

function makeTitle(rng: Rng, site: SiteDef): string {
  const t = site.topics;
  return `${rng.pick(t.adjectives)} ${rng.pick(t.nouns)} ${rng.pick(t.suffixes)}`;
}

function colorHex(imageId: number): string {
  const h = hashN(imageId, 991);
  const r = 40 + (h & 0xbf);
  const g = 40 + ((h >>> 8) & 0xbf);
  const b = 40 + ((h >>> 16) & 0xbf);
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function accountId(idx: number): string {
  return `2783${String(idx + 1).padStart(14, "0")}`;
}
function pinId(acct: number, idx: number): string {
  return `8139${String(acct + 1).padStart(2, "0")}${String(idx + 1).padStart(12, "0")}`;
}
function boardId(acct: number, idx: number): string {
  return `5521${String(acct + 1).padStart(2, "0")}${String(idx + 1).padStart(12, "0")}`;
}

interface ScenarioFns {
  /** account-wide multiplier on impressions (all Pins + other component) */
  acct(day: number): number;
  /** outbound CTR multiplier */
  outMult(day: number): number;
  /** per-Pin impression multiplier */
  pin(p: PinRec, day: number): number;
  /** exponential growth rate per 90 days */
  growth: number;
}

function scenarioFns(def: AccountDef, today: number): ScenarioFns {
  const one = () => 1;
  switch (def.scenario) {
    case "platform_cliff":
      return { acct: (d) => (d >= today - 25 ? 0.15 : 1), outMult: one, pin: one, growth: 0.03 };
    case "domain_block":
      return { acct: one, outMult: one, pin: (p, d) => (p.domainSlug === "deal-hub" && d >= today - 30 ? 0.05 : 1), growth: 0.03 };
    case "quality_drop":
      return { acct: (d) => (d >= today - 20 ? 0.4 : 1), outMult: (d) => (d >= today - 20 ? 0.5 : 1), pin: one, growth: 0.03 };
    case "healthy":
      return { acct: one, outMult: one, pin: one, growth: 0.1 };
    case "agency_healthy_growth":
      return { acct: one, outMult: one, pin: one, growth: 0.15 };
    case "agency_mild_decline":
      return { acct: one, outMult: one, pin: one, growth: -0.1 };
    default:
      return { acct: one, outMult: one, pin: one, growth: 0.03 };
  }
}

function generate(seed: number, today: number): Dataset {
  const firstDay = today - (HISTORY_DAYS - 1);
  const accounts: AccountData[] = [];
  const byUsername = new Map<string, AccountData>();
  const pinIndex = new Map<string, { account: AccountData; pin: PinRec }>();
  const images = new Map<string, { imageId: number; variant: number }>();

  ACCOUNTS.forEach((def, aIdx) => {
    const acct = generateAccount(seed, today, firstDay, def, aIdx);
    accounts.push(acct);
    byUsername.set(def.username, acct);
    for (const p of acct.pins) {
      pinIndex.set(p.id, { account: acct, pin: p });
      images.set(p.id, { imageId: p.imageId, variant: p.imageVariant });
    }
    images.set(`account-${acct.id}`, { imageId: acct.profileImageId, variant: 0 });
  });

  return { seed, today, firstDay, accounts, byUsername, pinIndex, images };
}

function generateAccount(seed: number, today: number, firstDay: number, def: AccountDef, aIdx: number): AccountData {
  const rng = new Rng(hashN(seed, aIdx, 0x51ed));
  const fns = scenarioFns(def, today);
  const verified = new Set(def.domains.filter((d) => d.status === "verified").map((d) => d.slug));

  // ---- 1. creation days (posting rate ramps from ~0.1/week two years ago to ~3-7/week now) ----
  const createdDays: number[] = [];
  const isRecentBurst: boolean[] = [];
  const burst = def.scenario === "new_pins_zero" ? 40 : 0;
  const olderCount = def.pinCount - burst - (def.scenario === "viral_fade" ? 1 : 0);
  const olderSpan = def.scenario === "new_pins_zero" ? HISTORY_DAYS - 21 : HISTORY_DAYS;
  for (let i = 0; i < olderCount; i++) {
    const u = rng.float();
    const t = -0.05 + Math.sqrt(0.0025 + 1.1 * u); // inverse CDF of density ∝ (0.05 + t)
    createdDays.push(firstDay + Math.min(olderSpan - 1, Math.floor(t * olderSpan)));
    isRecentBurst.push(false);
  }
  for (let i = 0; i < burst; i++) {
    createdDays.push(today - 20 + rng.int(0, 20));
    isRecentBurst.push(true);
  }
  let viralCreated = -1;
  if (def.scenario === "viral_fade") {
    viralCreated = today - 35;
    createdDays.push(viralCreated);
    isRecentBurst.push(false);
  }
  const order = createdDays.map((d, i) => ({ d, i, tie: rng.float() })).sort((a, b) => a.d - b.d || a.tie - b.tie);

  // ---- 2. boards ----
  const primarySite = SITE_BY_SLUG.get(def.domains[0].slug)!;
  const boards: BoardRec[] = [];
  const boardNames = new Set<string>();
  for (let b = 0; b < def.boardCount; b++) {
    const site = SITE_BY_SLUG.get(def.domains[b % def.domains.length].slug)!;
    let name = "";
    for (let tries = 0; tries < 20; tries++) {
      name = titleCase(`${rng.pick(site.topics.adjectives)} ${rng.pick(site.topics.nouns)}`);
      if (!boardNames.has(name)) break;
    }
    if (boardNames.has(name)) name = `${name} ${b + 1}`;
    boardNames.add(name);
    boards.push({
      id: boardId(aIdx, b),
      idx: b,
      name,
      description: `MOCK board: ${name.toLowerCase()} ideas (synthetic data).`,
      createdDay: firstDay - 30 + b,
      followerCount: Math.round(def.followers * (0.1 + 0.4 * rng.float())),
      pinIdxs: [],
    });
  }

  // ---- 3. pins ----
  const pins: PinRec[] = [];
  const dupSite = SITE_BY_SLUG.get(def.domains[0].slug)!;
  const dupTitle = makeTitle(new Rng(hashN(seed, aIdx, 0xd0b)), dupSite);
  const dupPath = `/${dupSite.slug}/${slugifyWords(dupTitle)}-p${aIdx + 1}9999`;
  const dupImageId = hashN(seed, aIdx, 0xd0b1);
  let dupCount = 0;
  let variantCount = 0;

  order.forEach((o, idx) => {
    const day = o.d;
    const recent = isRecentBurst[o.i];
    const isViral = viralCreated >= 0 && o.i === createdDays.length - 1;
    let domain: AccountDomain | null = isViral ? def.domains[0] : rng.chance(def.noLinkShare) ? null : pickWeighted(rng, def.domains);
    const site = domain ? SITE_BY_SLUG.get(domain.slug)! : primarySite;
    let title = makeTitle(rng, site);
    const fr = rng.float();
    const format: OrganicPinFormat = fr < 0.85 ? "ORGANIC_IMAGE" : fr < 0.94 ? "ORGANIC_VIDEO" : "ORGANIC_PRODUCT";
    let imageId = hashN(seed, aIdx, idx, 0x1a9e);
    let imageVariant = 0;
    let linkPath: string | null = null;
    let isDuplicate = false;
    if (domain) {
      let prefix = "";
      if (site.behaviour === "not_found_old_paths" && rng.chance(0.35)) prefix = "old/";
      if (site.behaviour === "slow_path" && rng.chance(0.2)) prefix = "slow/";
      linkPath = `/${site.slug}/${prefix}${slugifyWords(title)}-p${aIdx + 1}${String(idx).padStart(4, "0")}`;
    }
    // Cause C: most of the recent burst are duplicates of one Pin (same link + image).
    if (recent && rng.chance(0.75)) {
      domain = def.domains[0];
      title = dupTitle;
      linkPath = dupPath;
      imageId = dupImageId;
      isDuplicate = true;
      dupCount++;
      if (dupCount % 7 === 3 && variantCount < 4) {
        variantCount++;
        imageVariant = variantCount; // one pixel row changed
      }
    }
    const boardIdx = rng.int(0, boards.length - 1);
    // Pins created on MOCK_TODAY get a time in the first hour so created_at is rarely ahead of the real clock.
    const createdAt = new Date(day * DAY_MS + Math.floor(rng.float() * (day === today ? 3_599 : 86_399)) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const pin: PinRec = {
      id: pinId(aIdx, idx),
      idx,
      createdDay: day,
      createdAt,
      boardIdx,
      title: titleCase(title),
      description: `${titleCase(title)}. MOCK Pin with synthetic data for PinPulse development.`,
      altText: rng.chance(0.3) ? `Photo: ${title}` : null,
      linkPath,
      domainSlug: domain ? domain.slug : null,
      claimed: domain ? verified.has(domain.slug) : false,
      format: isViral ? "ORGANIC_IMAGE" : format,
      imageId,
      imageVariant,
      dominantColor: colorHex(imageId),
      isViral,
      isDuplicate,
    };
    pins.push(pin);
    boards[boardIdx].pinIdxs.push(idx);
  });

  // ---- 4. metrics ----
  const n = pins.length;
  const series = new Int32Array(n * N_BASE * HISTORY_DAYS);
  const other = new Int32Array(N_BASE * HISTORY_DAYS);
  const refDay = today - 45;
  const q = new Float64Array(n);
  const saveRate = new Float64Array(n);
  const clickRate = new Float64Array(n);
  const outRate = new Float64Array(n);
  let norm = 0;
  for (let i = 0; i < n; i++) {
    const p = pins[i];
    q[i] = Math.min(rng.pareto(1.15), 400);
    saveRate[i] = 0.008 + 0.02 * rng.float();
    clickRate[i] = 0.008 + 0.015 * rng.float();
    outRate[i] = p.linkPath ? 0.004 + 0.012 * rng.float() : 0;
    if (!p.isViral && p.createdDay <= refDay) norm += q[i] * lifeCurve(refDay - p.createdDay);
  }
  const target = def.dailyImpressions;

  // account-level day factors
  const dayFactor = new Float64Array(HISTORY_DAYS);
  const outMult = new Float64Array(HISTORY_DAYS);
  for (let o = 0; o < HISTORY_DAYS; o++) {
    const d = firstDay + o;
    const noise = Math.max(0.85, Math.min(1.15, 1 + 0.04 * rng.gauss()));
    dayFactor[o] = SEASON[weekday(d)] * Math.exp((fns.growth * (d - refDay)) / 90) * noise * fns.acct(d);
    outMult[o] = fns.outMult(d);
  }
  const lagFrac = (o: number) => LAG_FRACTIONS[HISTORY_DAYS - 1 - o] ?? 1;

  for (let i = 0; i < n; i++) {
    const p = pins[i];
    const startO = p.createdDay - firstDay;
    const scale = (target * q[i]) / norm;
    const recentZero = def.scenario === "new_pins_zero" && p.createdDay >= today - 20;
    const prng = new Rng(hashN(seed, aIdx, i, 0x9e37));
    const bImp = (i * N_BASE + B_IMP) * HISTORY_DAYS;
    const bSave = (i * N_BASE + B_SAVE) * HISTORY_DAYS;
    const bClick = (i * N_BASE + B_PIN_CLICK) * HISTORY_DAYS;
    const bOut = (i * N_BASE + B_OUTBOUND) * HISTORY_DAYS;
    for (let o = Math.max(0, startO); o < HISTORY_DAYS; o++) {
      const d = firstDay + o;
      let imp: number;
      let save: number;
      let click: number;
      let out: number;
      if (recentZero) {
        imp = prng.int(0, 2);
        save = 0;
        click = imp > 0 && prng.chance(0.04) ? 1 : 0;
        out = 0;
      } else {
        let lambda: number;
        if (p.isViral) {
          const a = d - p.createdDay;
          const shape = a <= 5 ? (a + 1) / 6 : Math.exp(-(a - 5) / 11) + 0.01;
          lambda = target * 10 * shape * dayFactor[o] * (1 + 0.03 * prng.gauss());
        } else {
          const noise = Math.exp(0.25 * prng.gauss() - 0.03125);
          lambda = scale * lifeCurve(d - p.createdDay) * dayFactor[o] * fns.pin(p, d) * noise;
        }
        imp = prng.poisson(lambda);
        save = Math.min(imp, prng.poisson(imp * saveRate[i]));
        click = Math.min(imp, prng.poisson(imp * clickRate[i]));
        out = Math.min(imp, prng.poisson(imp * outRate[i] * outMult[o]));
      }
      const f = lagFrac(o);
      if (f < 1) {
        imp = Math.floor(imp * f);
        save = Math.floor(save * f);
        click = Math.floor(click * f);
        out = Math.floor(out * f);
      }
      series[bImp + o] = imp;
      series[bSave + o] = save;
      series[bClick + o] = click;
      series[bOut + o] = out;
    }
  }

  const hasClaimed = verified.size > 0;
  if (hasClaimed) {
    const orng = new Rng(hashN(seed, aIdx, 0x07e2));
    for (let o = 0; o < HISTORY_DAYS; o++) {
      // Other people's saves of claimed content start small and grow with the account.
      const ramp = Math.min(1, (o + 30) / 365);
      const imp = orng.poisson(0.08 * target * dayFactor[o] * ramp);
      const f = lagFrac(o);
      other[B_IMP * HISTORY_DAYS + o] = Math.floor(imp * f);
      other[B_SAVE * HISTORY_DAYS + o] = Math.floor(Math.min(imp, orng.poisson(imp * 0.02)) * f);
      other[B_PIN_CLICK * HISTORY_DAYS + o] = Math.floor(Math.min(imp, orng.poisson(imp * 0.012)) * f);
      other[B_OUTBOUND * HISTORY_DAYS + o] = Math.floor(Math.min(imp, orng.poisson(imp * 0.006 * outMult[o])) * f);
    }
  }

  const m = 0.68 + 0.1 * unitHash(seed, aIdx, 1);
  const t = 0.05 + 0.04 * unitHash(seed, aIdx, 2);
  return {
    def,
    idx: aIdx,
    id: accountId(aIdx),
    pins,
    boards,
    series,
    other,
    appShares: [m, t, 1 - m - t],
    hasClaimed,
    profileImageId: hashN(seed, aIdx, 0xface),
  };
}
