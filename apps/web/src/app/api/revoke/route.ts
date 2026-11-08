import { NextResponse, type NextRequest } from "next/server";
import { revokeByToken } from "@/modules/pinterest/connections";

export async function POST(req: NextRequest) {
  const f = await req.formData();
  const ok = await revokeByToken(String(f.get("token") ?? ""));
  return NextResponse.redirect(new URL(`/revoke/done?ok=${ok ? 1 : 0}`, req.url), 303);
}
