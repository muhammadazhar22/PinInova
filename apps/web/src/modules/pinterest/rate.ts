/**
 * Per-connection, per-category rate state. Pinterest limits are per user per app
 * (Standard: org_analytics 60/min, org_read 1000/min). The local bucket is a floor;
 * response headers (x-ratelimit-remaining/reset) override it because Pinterest says
 * limits may change without notice.
 */
export type Category = "org_analytics" | "org_read" | "oauth";

export const DEFAULT_LIMITS: Record<Category, number> = { org_analytics: 60, org_read: 1000, oauth: 60 };

export class RateGate {
  private tokens: number;
  private last: number;
  private blockedUntil = 0;
  constructor(private perMinute: number, private now: () => number = Date.now) {
    this.tokens = perMinute;
    this.last = now();
  }
  /** Milliseconds to wait before the next call may be sent (0 = go now). Consumes a token when 0. */
  take(): number {
    const t = this.now();
    if (t < this.blockedUntil) return this.blockedUntil - t;
    this.tokens = Math.min(this.perMinute, this.tokens + ((t - this.last) / 60000) * this.perMinute);
    this.last = t;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    return Math.ceil(((1 - this.tokens) / this.perMinute) * 60000);
  }
  observe(headers: { limit?: number; remaining?: number; resetSeconds?: number }) {
    if (headers.limit && headers.limit > 0) this.perMinute = headers.limit;
    if (headers.remaining !== undefined) {
      this.tokens = Math.min(this.tokens, headers.remaining);
      if (headers.remaining <= 0 && headers.resetSeconds !== undefined) {
        this.blockedUntil = this.now() + Math.max(1, headers.resetSeconds) * 1000;
      }
    }
  }
  block(ms: number) {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + ms);
  }
}
