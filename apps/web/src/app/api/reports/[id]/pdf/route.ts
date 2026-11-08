import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/modules/auth/auth";
import { renderReportPdf } from "@/modules/reports/pdf";
import { asUser } from "@/modules/workspaces/access";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return new NextResponse("Sign in required", { status: 401 });
  const { id } = await ctx.params;
  const ws = req.nextUrl.searchParams.get("ws") ?? "";
  const row = await asUser(session.user.id, ws, async (tx) => (await tx<{ pdf: Buffer | null; kind: string }[]>`SELECT pdf, kind FROM report WHERE id = ${id}`)[0]).catch(() => null);
  if (!row) return new NextResponse("Not found", { status: 404 });
  const pdf = row.pdf ?? (await renderReportPdf(ws, id));
  return new NextResponse(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="pinpulse-${row.kind}-${id.slice(0, 8)}.pdf"`, "Cache-Control": "private, no-store" } });
}
