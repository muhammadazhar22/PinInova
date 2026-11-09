import { NextResponse } from "next/server";
import { workerStatus } from "@/modules/jobs/heartbeat";

/** Uptime check for the background worker (SPEC-072): 200 while its heartbeat is fresh, 503 otherwise. */
export const dynamic = "force-dynamic";

export async function GET() {
  const s = await workerStatus().catch(() => ({ ok: false, last_beat_age_s: null, workers: 0 }));
  return NextResponse.json(s, { status: s.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
