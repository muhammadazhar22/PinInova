/**
 * Static catalogue: mock "domains" (served by the mock websites server under /<slug>/...)
 * and the seeded mock accounts with their scenarios. Shared by the API and sites servers.
 */

export type SiteBehaviour = "normal" | "robots_disallow_pinterestbot" | "redirect_chain_3" | "not_found_old_paths" | "slow_path" | "crawl_delay_10";

export interface SiteDef {
  slug: string;
  behaviour: SiteBehaviour;
  description: string;
  /** Words used to build Pin titles linking to this site. */
  topics: { adjectives: string[]; nouns: string[]; suffixes: string[] };
}

export const SITES: SiteDef[] = [
  {
    slug: "cozy-kitchen",
    behaviour: "normal",
    description: "Normal pages: 200 with <title> = Pin title.",
    topics: {
      adjectives: ["easy", "creamy", "healthy", "quick", "classic", "spicy", "lemon", "vegan", "crispy", "rustic"],
      nouns: ["pasta", "soup", "salad", "cake", "curry", "bread", "pancakes", "tacos", "cookies", "risotto"],
      suffixes: ["recipe", "for weeknights", "in thirty minutes", "for beginners", "meal prep"],
    },
  },
  {
    slug: "garden-notes",
    behaviour: "normal",
    description: "Normal pages: 200 with <title> = Pin title.",
    topics: {
      adjectives: ["small", "shady", "balcony", "raised", "summer", "winter", "native", "herb", "cottage", "container"],
      nouns: ["garden", "planter", "border", "bed", "patio", "greenhouse", "pond", "trellis", "lawn", "rockery"],
      suffixes: ["ideas", "layout", "guide", "on a budget", "makeover"],
    },
  },
  {
    slug: "deal-hub",
    behaviour: "robots_disallow_pinterestbot",
    description: "robots.txt disallows Pinterestbot (and the Pinterest/0.2 UA); pages otherwise 200.",
    topics: {
      adjectives: ["best", "cheap", "flash", "top", "weekly", "hidden", "seasonal", "bundle", "clearance", "daily"],
      nouns: ["headphones", "sneakers", "blender", "backpack", "lamp", "watch", "jacket", "kettle", "speaker", "duvet"],
      suffixes: ["deals", "discount", "price drop", "sale picks", "bargains"],
    },
  },
  {
    slug: "redirect-shop",
    behaviour: "redirect_chain_3",
    description: "Every page answers with a 3-hop redirect chain (301 -> 302 -> 307) before the final 200 page.",
    topics: {
      adjectives: ["handmade", "ceramic", "linen", "woven", "minimal", "boho", "oak", "brass", "velvet", "marble"],
      nouns: ["vase", "mug", "throw", "basket", "shelf", "mirror", "candle", "rug", "tray", "planter"],
      suffixes: ["shop", "collection", "gift idea", "home decor", "set"],
    },
  },
  {
    slug: "broken-links",
    behaviour: "not_found_old_paths",
    description: "Paths under /broken-links/old/... return 404 (removed product pages); other paths 200.",
    topics: {
      adjectives: ["leather", "canvas", "vintage", "silk", "wool", "denim", "suede", "cotton", "knit", "faux"],
      nouns: ["tote", "scarf", "boots", "wallet", "hat", "belt", "dress", "cardigan", "skirt", "blazer"],
      suffixes: ["outfit", "style", "lookbook", "trend", "capsule wardrobe"],
    },
  },
  {
    slug: "slow-blog",
    behaviour: "slow_path",
    description: "Paths under /slow-blog/slow/... respond after a 5 s delay; other paths are fast.",
    topics: {
      adjectives: ["hidden", "coastal", "alpine", "budget", "weekend", "solo", "family", "rainy", "autumn", "island"],
      nouns: ["itinerary", "roadtrip", "hike", "beach", "city break", "cabin", "food tour", "village", "lake", "market"],
      suffixes: ["travel guide", "tips", "bucket list", "packing list", "photo spots"],
    },
  },
  {
    slug: "crawl-delay-co",
    behaviour: "crawl_delay_10",
    description: "robots.txt sets Crawl-delay: 10 for all agents (Pinterest honours at most 1).",
    topics: {
      adjectives: ["cozy", "scandi", "modern", "japandi", "coastal", "eclectic", "neutral", "dark", "bright", "tiny"],
      nouns: ["living room", "bedroom", "kitchen", "bathroom", "entryway", "home office", "nursery", "reading nook", "loft", "studio"],
      suffixes: ["decor", "inspiration", "makeover", "ideas", "styling"],
    },
  },
];

export const SITE_BY_SLUG = new Map(SITES.map((s) => [s.slug, s]));

export type ScenarioId =
  | "healthy"
  | "platform_cliff"
  | "domain_block"
  | "new_pins_zero"
  | "quality_drop"
  | "viral_fade"
  | "agency_healthy_growth"
  | "agency_mild_decline";

export interface AccountDomain {
  slug: string;
  /** Share of linked Pins pointing at this domain. */
  weight: number;
  /** Website claim status reported by GET /v5/user_account/websites. */
  status: "verified" | "unverified";
  /** When true, a verified site omits verified_at (the spec says it is "sometimes missing"). */
  omitVerifiedAt?: boolean;
}

export interface AccountDef {
  username: string;
  scenario: ScenarioId;
  /** Cause letter from the PinInova cause taxonomy, if any. */
  cause: "A" | "B" | "C" | "D" | "E" | null;
  summary: string;
  businessName: string;
  pinCount: number;
  boardCount: number;
  /** Target YOUR_PINS impressions/day around 30–60 days ago (before any scenario event). */
  dailyImpressions: number;
  domains: AccountDomain[];
  /** Share of Pins without a link. */
  noLinkShare: number;
  followers: number;
}

export const ACCOUNTS: AccountDef[] = [
  {
    username: "mock_healthy",
    scenario: "healthy",
    cause: null,
    summary: "Weekly seasonality, mild upward trend, no cliff.",
    businessName: "Cozy Garden Kitchen (MOCK)",
    pinCount: 260,
    boardCount: 6,
    dailyImpressions: 6000,
    domains: [
      { slug: "cozy-kitchen", weight: 0.6, status: "verified" },
      { slug: "garden-notes", weight: 0.4, status: "verified" },
    ],
    noLinkShare: 0.1,
    followers: 4200,
  },
  {
    username: "mock_platform_cliff",
    scenario: "platform_cliff",
    cause: "D",
    summary: "Cause D: account-wide ~85% step drop starting 25 days before MOCK_TODAY across all Pin ages and domains; CTR unchanged.",
    businessName: "Cliffside Recipes (MOCK)",
    pinCount: 320,
    boardCount: 7,
    dailyImpressions: 9000,
    domains: [
      { slug: "cozy-kitchen", weight: 0.55, status: "verified" },
      { slug: "garden-notes", weight: 0.45, status: "verified" },
    ],
    noLinkShare: 0.12,
    followers: 8100,
  },
  {
    username: "mock_domain_block",
    scenario: "domain_block",
    cause: "A",
    summary: "Cause A: Pins linking to deal-hub (robots.txt disallows Pinterestbot) fall ~95% from 30 days ago; other domains and unlinked Pins unchanged.",
    businessName: "Deal Hub Picks (MOCK)",
    pinCount: 300,
    boardCount: 6,
    dailyImpressions: 8000,
    domains: [
      { slug: "deal-hub", weight: 0.5, status: "verified" },
      { slug: "cozy-kitchen", weight: 0.35, status: "verified" },
      { slug: "garden-notes", weight: 0.15, status: "unverified" },
    ],
    noLinkShare: 0.1,
    followers: 5600,
  },
  {
    username: "mock_new_pins_zero",
    scenario: "new_pins_zero",
    cause: "C",
    summary: "Cause C: Pins created in the last 21 days get 0–2 impressions/day; older Pins fine; most recent Pins are duplicates (same link URL and image, a few one-row image variants).",
    businessName: "Planter Ideas Daily (MOCK)",
    pinCount: 240,
    boardCount: 5,
    dailyImpressions: 5000,
    domains: [
      { slug: "garden-notes", weight: 0.7, status: "verified" },
      { slug: "cozy-kitchen", weight: 0.3, status: "unverified" },
    ],
    noLinkShare: 0.08,
    followers: 2900,
  },
  {
    username: "mock_quality_drop",
    scenario: "quality_drop",
    cause: "B",
    summary: "Cause B: impressions fall ~60% from 20 days ago and outbound CTR halves; some links on broken-links 404.",
    businessName: "Capsule Style Notes (MOCK)",
    pinCount: 280,
    boardCount: 6,
    dailyImpressions: 7000,
    domains: [
      { slug: "broken-links", weight: 0.6, status: "verified" },
      { slug: "cozy-kitchen", weight: 0.4, status: "verified" },
    ],
    noLinkShare: 0.1,
    followers: 6300,
  },
  {
    username: "mock_viral_fade",
    scenario: "viral_fade",
    cause: "E",
    summary: "Cause E: one Pin peaked ~30 days ago carrying >50% of 90-day impressions and decays smoothly.",
    businessName: "Garden Glow-Up (MOCK)",
    pinCount: 200,
    boardCount: 5,
    dailyImpressions: 4000,
    domains: [
      { slug: "garden-notes", weight: 0.65, status: "verified" },
      { slug: "cozy-kitchen", weight: 0.35, status: "verified", omitVerifiedAt: true },
    ],
    noLinkShare: 0.1,
    followers: 3100,
  },
  {
    username: "mock_agency_client_1",
    scenario: "agency_healthy_growth",
    cause: null,
    summary: "Agency client 1: healthy, steady growth; links via redirect-shop (3-hop redirect chain).",
    businessName: "Oak & Brass Home (MOCK)",
    pinCount: 230,
    boardCount: 4,
    dailyImpressions: 3500,
    domains: [
      { slug: "redirect-shop", weight: 0.7, status: "verified" },
      { slug: "cozy-kitchen", weight: 0.3, status: "unverified" },
    ],
    noLinkShare: 0.15,
    followers: 1800,
  },
  {
    username: "mock_agency_client_2",
    scenario: "agency_mild_decline",
    cause: null,
    summary: "Agency client 2: healthy-ish, gentle ~10% decline over 90 days; crawl-delay-co (Crawl-delay: 10) and slow-blog (one 5 s path).",
    businessName: "Wander Rooms (MOCK)",
    pinCount: 380,
    boardCount: 8,
    dailyImpressions: 12000,
    domains: [
      { slug: "crawl-delay-co", weight: 0.45, status: "verified" },
      { slug: "slow-blog", weight: 0.4, status: "verified" },
      { slug: "garden-notes", weight: 0.15, status: "unverified" },
    ],
    noLinkShare: 0.12,
    followers: 15200,
  },
];

export const ACCOUNT_BY_USERNAME = new Map(ACCOUNTS.map((a) => [a.username, a]));
export const DEFAULT_AUTO_CONSENT_USER = "mock_healthy";
