import Link from "next/link";
import { Card } from "@/components/ui";
import { OnboardingForm } from "@/components/Forms";
import { requireUser } from "@/modules/auth/session";
import { listOrgsForUser, listWorkspacesForUser } from "@/modules/workspaces/access";
import { addWorkspace } from "./actions";

export const metadata = { title: "Workspaces" };

export default async function AppHome() {
  const user = await requireUser();
  const [orgs, workspaces] = await Promise.all([listOrgsForUser(user.id), listWorkspacesForUser(user.id)]);
  if (!orgs.length && !workspaces.length) {
    return (
      <div className="mx-auto max-w-lg">
        <h1>Set up PinInova</h1>
        <p className="muted mb-4 mt-1">Create a workspace, then connect a Pinterest account. Access is read-only.</p>
        <Card><OnboardingForm /></Card>
      </div>
    );
  }
  return (
    <div className="space-y-6">
      <h1>Workspaces</h1>
      {orgs.map((o) => (
        <Card key={o.id} title={o.name} action={<span className="muted text-xs">Your role: {o.role}</span>}>
          <ul className="divide-y divide-stone-100">
            {workspaces.filter((w) => w.org_id === o.id).map((w) => (
              <li key={w.id} className="flex items-center justify-between py-2">
                <Link className="font-medium hover:underline" href={`/app/w/${w.id}`}>{w.name}</Link>
                <span className="muted text-xs">{w.kind === "client" ? "Client" : "Own account"}{w.niche ? ` · ${w.niche}` : ""}</span>
              </li>
            ))}
          </ul>
          {["owner", "admin", "member"].includes(o.role) && (
            <form action={addWorkspace} className="mt-3 flex flex-wrap items-end gap-2">
              <input type="hidden" name="org" value={o.id} />
              <div className="grow"><label className="label" htmlFor={`n-${o.id}`}>New client workspace</label><input className="input" id={`n-${o.id}`} name="name" placeholder="Client name" required /></div>
              <button className="btn-secondary">Add workspace</button>
            </form>
          )}
        </Card>
      ))}
      {workspaces.some((w) => w.role === "client_viewer") && (
        <Card title="Shared with you">
          <ul>{workspaces.filter((w) => w.role === "client_viewer").map((w) => <li key={w.id}><Link className="hover:underline" href={`/app/w/${w.id}`}>{w.name}</Link> <span className="muted text-xs">by {w.org_name} · read-only</span></li>)}</ul>
        </Card>
      )}
    </div>
  );
}
