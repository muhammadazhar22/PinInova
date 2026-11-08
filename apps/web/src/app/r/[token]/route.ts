import { NextResponse, type NextRequest } from "next/server";
import { db, withWorkspace } from "@/lib/db";
import { hashToken } from "@/lib/tokens";

/** Public share link for a report. Static HTML only; scripts, network and framing are blocked by CSP. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const [r] = await db()<{ workspace_id: string; report_id: string }[]>`SELECT * FROM system_workspace_of_share_token(${hashToken(token)})`;
  if (!r) return new NextResponse("This link has expired or was revoked.", { status: 404 });
  const [row] = await withWorkspace(r.workspace_id, (tx) => tx<{ html: string }[]>`SELECT html FROM report WHERE id = ${r.report_id}`);
  if (!row) return new NextResponse("Not found", { status: 404 });
  return new NextResponse(row.html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; frame-ancestors 'none'", "X-Robots-Tag": "noindex", "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer" },
  });
}
