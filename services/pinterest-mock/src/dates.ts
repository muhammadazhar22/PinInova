/** UTC calendar-day helpers. A "day number" is days since 1970-01-01 (UTC). */

const DAY_MS = 86_400_000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseIsoDate(s: string): number | null {
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.floor(ms / DAY_MS);
}

export function formatDay(dayNumber: number): string {
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

export function dayToMs(dayNumber: number): number {
  return dayNumber * DAY_MS;
}

export function todayUtcDayNumber(nowMs: number): number {
  return Math.floor(nowMs / DAY_MS);
}

/** 0 = Sunday ... 6 = Saturday */
export function weekday(dayNumber: number): number {
  return (((dayNumber + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
}

export { DAY_MS };
