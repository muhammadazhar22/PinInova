import { NextResponse, type NextRequest } from "next/server";
import { lookupConsentRequest, startConnect } from "@/modules/pinterest/connections";

export async function POST(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const form = await req.formData();
  if (form.get("agree") !== "yes") return NextResponse.redirect(new URL(`/consent/${token}?e=agree`, req.url), 303);
  const r = await lookupConsentRequest(token);
  if (!r || r.used_at || r.expires_at < new Date()) return NextResponse.redirect(new URL(`/consent/${token}`, req.url), 303);
  const url = await startConnect({ workspaceId: r.workspace_id, userId: null, consentRequestId: r.consent_request_id, redirectTo: "/consent/done" });
  return NextResponse.redirect(url, 303);
}
