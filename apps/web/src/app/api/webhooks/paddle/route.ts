import { NextResponse, type NextRequest } from "next/server";
import { handlePaddleEvent } from "@/modules/billing/paddle";

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const r = await handlePaddleEvent(raw, req.headers.get("paddle-signature"));
  return NextResponse.json({ ok: r.ok }, { status: r.status });
}
