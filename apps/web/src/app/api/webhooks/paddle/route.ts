import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/env";
import { handlePaddleEvent } from "@/modules/billing/paddle";

export async function POST(req: NextRequest) {
  // In simulated mode there is no Paddle account: the endpoint does not exist (its dev secret is public).
  if (env().BILLING_MODE === "simulated") return NextResponse.json({ ok: false }, { status: 404 });
  const raw = await req.text();
  const r = await handlePaddleEvent(raw, req.headers.get("paddle-signature"));
  return NextResponse.json({ ok: r.ok }, { status: r.status });
}
