import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/modules/auth/auth";
import { asUser } from "@/modules/workspaces/access";

const REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'self'";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return new NextResponse("Sign in required", { status: 401 });
  const { id } = await ctx.params;
  const ws = req.nextUrl.searchParams.get("ws") ?? "";
  const row = await asUser(session.user.id, ws, async (tx) => (await tx<{ html: string }[]>`SELECT html FROM report WHERE id = ${id}`)[0]).catch(() => null);
  if (!row) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(row.html, { headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": REPORT_CSP, "X-Frame-Options": "SAMEORIGIN", "Cache-Control": "private, no-store" } });
}
