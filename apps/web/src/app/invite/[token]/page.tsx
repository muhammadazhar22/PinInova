import Link from "next/link";
import { currentUser } from "@/modules/auth/session";
import { acceptInviteAction } from "@/app/app/actions";

export const metadata = { title: "Workspace invitation" };

export default async function InvitePage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ e?: string }> }) {
  const { token } = await params;
  const { e } = await searchParams;
  const user = await currentUser();
  const next = `/invite/${encodeURIComponent(token)}`;
  return (
    <main className="mx-auto mt-20 max-w-lg px-4">
      <h1>Workspace invitation</h1>
      <p className="muted mt-2">You've been invited to view a client workspace on PinPulse. Access is read-only: you can see health, incidents and reports, but not change settings or connections.</p>
      {e === "invalid" && <p role="alert" className="mt-4 rounded-lg bg-red-50 p-3 text-sm text-red-900">This invitation has already been used or has expired. Ask for a new one.</p>}
      {user ? (
        <form action={acceptInviteAction} className="card mt-6">
          <input type="hidden" name="token" value={token} />
          <p className="text-sm">Signed in as <b>{user.email}</b>.</p>
          <button className="btn-primary mt-3">Accept and open the workspace</button>
        </form>
      ) : (
        <div className="card mt-6 text-sm">
          <p>Sign in or create a PinPulse account to accept.</p>
          <div className="mt-3 flex gap-2">
            <Link className="btn-primary" href={`/login?next=${encodeURIComponent(next)}`}>Sign in</Link>
            <Link className="btn-secondary" href={`/signup?next=${encodeURIComponent(next)}`}>Create account</Link>
          </div>
        </div>
      )}
    </main>
  );
}
