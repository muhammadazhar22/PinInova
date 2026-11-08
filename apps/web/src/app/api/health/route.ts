import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/env";
import { workerStatus } from "@/modules/jobs/heartbeat";

export async function GET() {
  const dbOk = await db()`SELECT 1`.then(() => true).catch(() => false);
  const analyticsOk = await fetch(`${env().ANALYTICS_URL}/healthz`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
  // Worker liveness is reported but does not fail this endpoint (it is also the web container's healthcheck);
  // the uptime monitor checks GET /api/health/worker separately.
  const worker = dbOk ? await workerStatus().catch(() => null) : null;
  return NextResponse.json({ ok: dbOk, db: dbOk, analytics: analyticsOk, worker: worker?.ok ?? false, worker_last_beat_age_s: worker?.last_beat_age_s ?? null, pinterest_mode: env().PINTEREST_MODE }, { status: dbOk ? 200 : 503 });
}
