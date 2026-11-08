import { NextResponse, type NextRequest } from "next/server";
import { ConnectError, completeConnect } from "@/modules/pinterest/connections";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const state = q.get("state");
  if (!state) return new NextResponse("Missing state", { status: 400 });
  try {
    const r = await completeConnect({ state, code: q.get("code"), error: q.get("error") });
    if (r.viaClientLink) {
      const res = NextResponse.redirect(new URL("/consent/done", req.url), 303);
      // The revoke link is shown once on the next page and never stored in plain text.
      res.cookies.set("pp_revoke", r.revokeToken ?? "", { httpOnly: true, sameSite: "lax", secure: req.nextUrl.protocol === "https:", maxAge: 600, path: "/consent/done" });
      return res;
    }
    return NextResponse.redirect(new URL(r.redirectTo.startsWith("/") ? r.redirectTo : "/app", req.url), 303);
  } catch (e) {
    const msg = e instanceof ConnectError ? e.message : "Could not connect the Pinterest account.";
    return NextResponse.redirect(new URL(`/connect-error?m=${encodeURIComponent(msg)}`, req.url), 303);
  }
}
