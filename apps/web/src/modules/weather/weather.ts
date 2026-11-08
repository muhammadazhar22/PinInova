import { createHash } from "node:crypto";
import { env } from "@/env";
import { db } from "@/lib/db";
import { addDays, todayUtc } from "@/lib/dates";
import { analytics } from "@/modules/health/analytics-client";

export const NICHES = ["food", "home", "diy", "fashion", "beauty", "travel", "parenting", "finance", "wedding", "health", "art", "ecommerce", "other"] as const;
export type Niche = (typeof NICHES)[number];
export const SYMPTOMS = ["impressions_drop", "new_pins_zero", "linked_pins_zero", "visit_site_missing", "ai_label", "outbound_clicks_drop"] as const;

/**
 * policy: PA-06 — the weather index is built ONLY from voluntary reports people submit about their own
 * accounts. No Pinterest API data from any tenant is read here.
 */
export function reporterHash(reporterId: string) {
  return createHash("sha256").update(`weather:${env().BETTER_AUTH_SECRET}:${reporterId}`).digest();
}

export async function submitReport(p: { reporterId: string; niche: Niche; status: "drop" | "normal"; onsetDate: string | null; symptoms: string[] }) {
  if (!NICHES.includes(p.niche)) throw new Error("unknown niche");
  const today = todayUtc();
  const onset = p.status === "drop" ? p.onsetDate ?? today : today;
  if (onset > today || onset < addDays(today, -60)) throw new Error("onset date must be within the last 60 days");
  const symptoms = p.symptoms.filter((s) => (SYMPTOMS as readonly string[]).includes(s));
  await db()`SELECT system_upsert_weather_report(${reporterHash(p.reporterId)}, ${p.niche}, ${onset}::date, ${symptoms}::text[], ${p.status}, ${today}::date)`;
}

export async function weatherIndex(p: { days?: number; niche?: Niche | null } = {}) {
  const to = todayUtc();
  const from = addDays(to, -(p.days ?? 60));
  const windows = await db()<{ date: string; reports: number; active_reporters: number }[]>`
    SELECT to_char(date,'YYYY-MM-DD') AS date, reports, active_reporters FROM system_weather_windows(${from}::date, ${to}::date, ${p.niche ?? null})`;
  const res = await analytics.weather(windows);
  return windows.map((w, i) => ({ ...w, ...(res.days[i] ?? { fraction: 0, log_bf: 0, tail_p: 1, level: "normal" as const, insufficient: true }) }));
}
