export const DAY = 86400_000;
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
export function addDays(iso: string, n: number): string {
  return isoDay(new Date(Date.parse(iso + "T00:00:00Z") + n * DAY));
}
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / DAY);
}
export function todayUtc(now = new Date()): string {
  return isoDay(now);
}
export function dateRange(start: string, end: string): string[] {
  const out: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

/**
 * Domain key used for per-domain analysis. In mock mode every fake site is served from one host
 * (127.0.0.1:<port>/<slug>/...), so the first path segment stands in for the domain. Live mode uses the hostname.
 */
export function domainKey(url: string | null | undefined, mode: "mock" | "live" = (process.env.PINTEREST_MODE as "mock" | "live") ?? "mock"): string | null {
  if (!url) return null;
  try {
    const u = new URL(url.includes("://") ? url : `https://${url}`);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (mode === "mock" && (host === "127.0.0.1" || host === "localhost")) {
      const seg = u.pathname.split("/").filter(Boolean)[0];
      return seg ? `${host}/${seg}` : host;
    }
    return host;
  } catch {
    return null;
  }
}
