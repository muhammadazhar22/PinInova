"use server";
import { cookies, headers } from "next/headers";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dropCheck } from "@/modules/imports/csv-history";
import { NICHES, submitReport, type Niche } from "@/modules/weather/weather";
import type { DiagnoseResponse } from "@/modules/health/analytics-client";

/**
 * Fixed-window limiter for unauthenticated actions (per process). X-Forwarded-For is client-controlled, so it is
 * only used when TRUST_PROXY=true, and then only its right-most entry (the one our own proxy appended). Without a
 * trusted proxy every caller shares one bucket with a higher ceiling. The map is bounded.
 */
const hits = new Map<string, { n: number; t: number }>();
async function clientKey() {
  if (process.env.TRUST_PROXY !== "true") return "shared";
  const xff = ((await headers()).get("x-forwarded-for") ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  return xff.at(-1) ?? "unknown";
}
async function limit(key: string, max: number, windowMs = 60_000) {
  const ip = await clientKey();
  const ceiling = ip === "shared" ? max * 20 : max;
  const k = `${key}:${ip}`;
  const now = Date.now();
  if (hits.size > 10_000) for (const [hk, v] of hits) if (now - v.t > windowMs) hits.delete(hk);
  if (hits.size > 10_000) hits.clear();
  const cur = hits.get(k);
  if (!cur || now - cur.t > windowMs) hits.set(k, { n: 1, t: now });
  else if (++cur.n > ceiling) throw new Error("Too many requests. Please wait a minute.");
}

export type DropCheckState = { error?: string; result?: DiagnoseResponse; days?: { date: string; impressions: number | null }[]; warnings?: string[]; columns?: Record<string, string> } | null;

export async function runDropCheck(_: DropCheckState, f: FormData): Promise<DropCheckState> {
  try {
    await limit("dropcheck", 10);
    const file = f.get("file");
    if (!(file instanceof File) || file.size === 0) return { error: "Choose your Pinterest Analytics CSV export." };
    if (file.size > 5 * 1024 * 1024) return { error: "File is larger than 5 MB." };
    const r = await dropCheck(await file.text());
    // Nothing is stored: the CSV is analysed in memory and discarded.
    return { result: r.result, days: r.rows.map((x) => ({ date: x.date, impressions: x.impressions })), warnings: r.warnings, columns: r.columns };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not analyse this file." };
  }
}

export type WeatherState = { ok?: boolean; error?: string } | null;
export async function submitWeather(_: WeatherState, f: FormData): Promise<WeatherState> {
  try {
    await limit("weather", 5);
    const jar = await cookies();
    let rid = jar.get("pp_reporter")?.value;
    if (!rid || !/^[0-9a-f-]{36}$/.test(rid)) {
      // New reporter identities are capped per client per day so one person cannot pose as many reporters.
      await limit("weather-new-reporter", 3, 86_400_000);
      rid = randomUUID();
      jar.set("pp_reporter", rid, { httpOnly: true, sameSite: "lax", maxAge: 400 * 86400, path: "/" });
    }
    const niche = z.enum(NICHES).parse(f.get("niche")) as Niche;
    const status = f.get("status") === "normal" ? "normal" : "drop";
    const onset = status === "drop" ? z.string().regex(/^\d{4}-\d{2}-\d{2}$/).parse(f.get("onset")) : null;
    await submitReport({ reporterId: rid, niche, status, onsetDate: onset, symptoms: f.getAll("symptoms").map(String) });
    return { ok: true };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "Could not save your report." };
  }
}
