import { NextResponse, type NextRequest } from "next/server";
import { audit } from "@/lib/audit";
import { auth } from "@/modules/auth/auth";
import { exportWorkspace } from "@/modules/queries";
import { asUser } from "@/modules/workspaces/access";

export async function GET(req: NextRequest, ctx: { params: Promise<{ ws: string }> }) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return new NextResponse("Sign in required", { status: 401 });
  const { ws } = await ctx.params;
  const data = await asUser(session.user.id, ws, async (tx) => {
    await audit(tx, { workspaceId: ws, actor: session.user.id, action: "workspace.exported" });
    return exportWorkspace(tx);
  }, { manage: true }).catch(() => null);
  if (!data) return new NextResponse("Not allowed", { status: 403 });
  const body = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? Number(v) : v instanceof Buffer ? undefined : v), 2);
  return new NextResponse(body, { headers: { "Content-Type": "application/json", "Content-Disposition": `attachment; filename="pininova-export-${ws.slice(0, 8)}.json"`, "Cache-Control": "no-store" } });
}
