/**
 * Fixed-window rate limiter keyed by (category, access token).
 * MOCK ASSUMPTION: a window is 60 s and starts at the first request in it;
 * `x-ratelimit-reset` = whole seconds until the current window ends (ceil, min 1).
 */
export type RateCategory = "org_analytics" | "org_read";

export interface RateState {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetSeconds: number;
}

export const WINDOW_MS = 60_000;

export class RateLimiter {
  private buckets = new Map<string, { start: number; count: number }>();
  constructor(private now: () => number) {}

  hit(key: string, limit: number): RateState {
    const now = this.now();
    let b = this.buckets.get(key);
    if (!b || now - b.start >= WINDOW_MS) {
      b = { start: now, count: 0 };
      this.buckets.set(key, b);
    }
    b.count++;
    const allowed = b.count <= limit;
    return {
      allowed,
      limit,
      remaining: Math.max(0, limit - b.count),
      resetSeconds: Math.max(1, Math.ceil((b.start + WINDOW_MS - now) / 1000)),
    };
  }

  reset(): void {
    this.buckets.clear();
  }

  snapshot() {
    const now = this.now();
    return [...this.buckets.entries()]
      .filter(([, b]) => now - b.start < WINDOW_MS)
      .map(([key, b]) => {
        const [category, token] = key.split("|");
        return { category, token_prefix: token.slice(0, 14), count: b.count, window_resets_in_s: Math.ceil((b.start + WINDOW_MS - now) / 1000) };
      });
  }
}
