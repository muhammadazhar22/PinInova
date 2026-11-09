import { NextResponse, type NextRequest } from "next/server";
import { appUrl, secureCookies } from "@/lib/urls";
import { auth } from "@/modules/auth/auth";
import { ConnectError, OAUTH_NONCE_COOKIE, completeConnect, safeRedirectPath } from "@/modules/pinterest/connections";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const state = q.get("state");
  if (!state) return new NextResponse("Missing state", { status: 400 });
  const session = await auth.api.getSession({ headers: req.headers }).catch(() => null);
  const nonce = req.cookies.get(OAUTH_NONCE_COOKIE)?.value;
  let res: NextResponse;
  try {
    const r = await completeConnect({ state, nonce, sessionUserId: session?.user.id ?? null, code: q.get("code"), error: q.get("error") });
    if (r.viaClientLink) {
      res = NextResponse.redirect(appUrl("/consent/done"), 303);
      // The revoke link is shown once on the next page and never stored in plain text.
      res.cookies.set("pp_revoke", r.revokeToken ?? "", { httpOnly: true, sameSite: "lax", secure: secureCookies(), maxAge: 600, path: "/consent/done" });
    } else {
      res = NextResponse.redirect(appUrl(safeRedirectPath(r.redirectTo)), 303);
    }
  } catch (e) {
    const reason = e instanceof ConnectError ? e.reason : "exchange_failed";
    res = NextResponse.redirect(appUrl(`/connect-error?r=${reason}`), 303);
  }
  res.cookies.delete({ name: OAUTH_NONCE_COOKIE, path: "/api/pinterest/callback" });
  return res;
}
