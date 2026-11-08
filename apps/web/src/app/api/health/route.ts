import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { env } from "@/env";

export async function GET() {
  const dbOk = await db()`SELECT 1`.then(() => true).catch(() => false);
  const analyticsOk = await fetch(`${env().ANALYTICS_URL}/healthz`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok).catch(() => false);
  return NextResponse.json({ ok: dbOk, db: dbOk, analytics: analyticsOk, pinterest_mode: env().PINTEREST_MODE }, { status: dbOk ? 200 : 503 });
}
