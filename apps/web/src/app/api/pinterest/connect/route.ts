import { NextResponse, type NextRequest } from "next/server";
import { auth } from "@/modules/auth/auth";
import { startConnect, OAUTH_NONCE_COOKIE } from "@/modules/pinterest/connections";
import { requireManage } from "@/modules/workspaces/access";
import { entitlements } from "@/modules/billing/plans";

export async function GET(req: NextRequest) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) return NextResponse.redirect(new URL("/login", req.url));
  const ws = req.nextUrl.searchParams.get("ws") ?? "";
  const acc = await requireManage(session.user.id, ws).catch(() => null);
  if (!acc) return new NextResponse("Not allowed", { status: 403 });
  const ent = await entitlements(acc.orgId);
  if (!ent.canConnect) return NextResponse.redirect(new URL(`/app/w/${ws}?error=${encodeURIComponent(`Your plan allows ${ent.accountLimit} connected accounts.`)}`, req.url));
  const { url, nonce } = await startConnect({ workspaceId: ws, userId: session.user.id, redirectTo: `/app/w/${ws}?connected=1`, orgId: acc.orgId });
  const res = NextResponse.redirect(url);
  res.cookies.set(OAUTH_NONCE_COOKIE, nonce, { httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", maxAge: 600, path: "/api/pinterest/callback" });
  return res;
}
