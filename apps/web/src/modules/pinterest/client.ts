import { DEFAULT_LIMITS, RateGate, type Category } from "./rate";
import { PinterestAuthError, PinterestError, PinterestForbiddenError, PinterestRateLimitError } from "./errors";
import type { AnalyticsResponse, Paginated, Pin, SplitField, TopPinsResponse, UserAccount, UserWebsite } from "./types";

export interface ClientOptions {
  baseUrl: string;
  accessToken: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
  baseBackoffMs?: number;
  /** Shared gates per connection so concurrent jobs respect one budget. */
  gates?: Map<Category, RateGate>;
  onCall?: (info: { path: string; status: number; category: Category }) => void;
}

const ANALYTICS_PATHS = [/^\/user_account\/analytics/, /^\/pins\/[^/]+\/analytics/, /^\/pins\/analytics/];

export class PinterestClient {
  private gates: Map<Category, RateGate>;
  private fetchImpl: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  public calls = 0;

  constructor(private o: ClientOptions) {
    this.gates = o.gates ?? new Map();
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private gate(c: Category): RateGate {
    let g = this.gates.get(c);
    if (!g) {
      g = new RateGate(DEFAULT_LIMITS[c]);
      this.gates.set(c, g);
    }
    return g;
  }

  async get<T>(path: string, query: Record<string, string | number | boolean | string[] | undefined> = {}): Promise<T> {
    const category: Category = ANALYTICS_PATHS.some((r) => r.test(path)) ? "org_analytics" : "org_read";
    const url = new URL(this.o.baseUrl.replace(/\/$/, "") + path);
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined) continue;
      url.searchParams.set(k, Array.isArray(v) ? v.join(",") : String(v));
    }
    const maxRetries = this.o.maxRetries ?? 5;
    const base = this.o.baseBackoffMs ?? 1000;
    for (let attempt = 0; ; attempt++) {
      let wait: number;
      while ((wait = this.gate(category).take()) > 0) await this.sleep(wait);
      let res: Response;
      try {
        this.calls++;
        res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.o.accessToken}`, Accept: "application/json" } });
      } catch (e) {
        if (attempt >= maxRetries) throw new PinterestError(0, undefined, `network error: ${(e as Error).message}`, true);
        await this.sleep(backoff(base, attempt));
        continue;
      }
      const h = res.headers;
      this.gate(category).observe({
        limit: numHeader(h.get("x-ratelimit-limit")),
        remaining: numHeader(h.get("x-ratelimit-remaining")),
        resetSeconds: numHeader(h.get("x-ratelimit-reset")),
      });
      this.o.onCall?.({ path, status: res.status, category });
      if (res.ok) return (await res.json()) as T;
      const body = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
      const msg = body.message ?? res.statusText;
      if (res.status === 401) throw new PinterestAuthError(401, body.code, msg);
      if (res.status === 403) throw new PinterestForbiddenError(403, body.code, msg);
      if (res.status === 429) {
        const reset = numHeader(h.get("x-ratelimit-reset"));
        this.gate(category).block(reset !== undefined ? Math.max(1, reset) * 1000 : backoff(base, attempt));
        if (attempt >= maxRetries) throw new PinterestRateLimitError(429, body.code, msg, true);
        continue;
      }
      if (res.status >= 500) {
        if (attempt >= maxRetries) throw new PinterestError(res.status, body.code, msg, true);
        await this.sleep(backoff(base, attempt));
        continue;
      }
      throw new PinterestError(res.status, body.code, msg);
    }
  }

  userAccount() {
    return this.get<UserAccount>("/user_account");
  }

  accountAnalytics(p: { start: string; end: string; split?: SplitField; metricTypes?: readonly string[]; contentType?: "ALL" | "PAID" | "ORGANIC"; fromClaimedContent?: "OTHER" | "CLAIMED" | "BOTH" }) {
    return this.get<AnalyticsResponse>("/user_account/analytics", {
      start_date: p.start,
      end_date: p.end,
      metric_types: [...(p.metricTypes ?? ["IMPRESSION", "OUTBOUND_CLICK", "PIN_CLICK", "SAVE"])],
      split_field: p.split ?? "NO_SPLIT",
      content_type: p.contentType,
      from_claimed_content: p.fromClaimedContent,
    });
  }

  topPins(p: { start: string; end: string; sortBy?: string; num?: number }) {
    return this.get<TopPinsResponse>("/user_account/analytics/top_pins", {
      start_date: p.start,
      end_date: p.end,
      sort_by: p.sortBy ?? "IMPRESSION",
      num_of_pins: Math.min(50, p.num ?? 50),
      metric_types: ["IMPRESSION", "OUTBOUND_CLICK", "PIN_CLICK", "SAVE"],
    });
  }

  async *listPins(p: { pageSize?: number; pinMetrics?: boolean } = {}): AsyncGenerator<Pin> {
    let bookmark: string | undefined;
    do {
      const page = await this.get<Paginated<Pin>>("/pins", { page_size: Math.min(250, p.pageSize ?? 250), bookmark, pin_metrics: p.pinMetrics || undefined });
      for (const item of page.items) yield item;
      bookmark = page.bookmark ?? undefined;
    } while (bookmark);
  }

  pinAnalytics(pinId: string, p: { start: string; end: string; metricTypes?: readonly string[] }) {
    if (!/^[A-Za-z0-9_-]+$/.test(pinId)) throw new Error("invalid pin id");
    return this.get<AnalyticsResponse>(`/pins/${pinId}/analytics`, {
      start_date: p.start,
      end_date: p.end,
      metric_types: [...(p.metricTypes ?? ["IMPRESSION", "OUTBOUND_CLICK", "PIN_CLICK", "SAVE"])],
    });
  }

  async websites(): Promise<UserWebsite[]> {
    const r = await this.get<Paginated<UserWebsite>>("/user_account/websites");
    return r.items ?? [];
  }
}

function numHeader(v: string | null): number | undefined {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function backoff(base: number, attempt: number): number {
  const cap = 16 * base;
  return Math.min(cap, base * 2 ** attempt) * (0.5 + Math.random() / 2);
}

/** Flatten an AnalyticsResponse into date-keyed rows per split key. */
export function flattenAnalytics(r: AnalyticsResponse): { split: string; date: string; status?: string; m: Record<string, number> }[] {
  const out: { split: string; date: string; status?: string; m: Record<string, number> }[] = [];
  for (const [split, v] of Object.entries(r)) {
    for (const d of v?.daily_metrics ?? []) out.push({ split: split.toLowerCase(), date: d.date, status: d.data_status, m: d.metrics ?? {} });
  }
  return out;
}
