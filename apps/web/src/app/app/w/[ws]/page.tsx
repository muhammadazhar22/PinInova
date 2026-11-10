import Link from "next/link";
import { Card, Chip, Empty, StatusChip, fmtDate } from "@/components/ui";
import { ConsentLinkForm } from "@/components/Forms";
import { requireUser } from "@/modules/auth/session";
import { CAUSE_LABELS, type Cause } from "@/modules/health/analytics-client";
import { workspaceOverview } from "@/modules/queries";
import { asUser } from "@/modules/workspaces/access";
import { entitlements } from "@/modules/billing/plans";

export default async function WorkspacePage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { ws } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const { data, acc } = await asUser(user.id, ws, async (tx, acc) => ({ data: await workspaceOverview(tx), acc }));
  const ent = await entitlements(acc.orgId);
  return (
    <div className="space-y-6">
      {sp.connected && <p role="status" className="rounded-lg bg-green-50 p-3 text-sm text-green-900">Pinterest account connected. The first sync is running; results appear in a few minutes.</p>}
      {sp.disconnected && <p role="status" className="rounded-lg bg-stone-100 p-3 text-sm">Account disconnected. Its tokens were destroyed and its data is being deleted.</p>}
      {sp.error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-900">{sp.error}</p>}
      <Card title="Pinterest accounts" action={acc.canManage && (ent.canConnect ? <a className="btn-primary" href={`/api/pinterest/connect?ws=${ws}`}>Connect Pinterest account</a> : <Link className="btn-secondary" href="/app/billing">Plan limit reached ({ent.activeAccounts}/{ent.accountLimit})</Link>)}>
        {data.conns.length === 0 ? (
          <Empty>No accounts yet. Connect your own account, or send a client a consent link below.</Empty>
        ) : (
          <table className="data">
            <thead><tr><th>Account</th><th>Status</th><th>Health</th><th>Open incident</th><th>Open issues</th><th>Last sync</th></tr></thead>
            <tbody>
              {data.conns.map((c) => (
                <tr key={c.id}>
                  <td><Link className="font-medium hover:underline" href={`/app/w/${ws}/a/${c.id}`}>@{c.username}</Link>{c.mode === "mock" && <Chip tone="warn">mock</Chip>}</td>
                  <td><StatusChip status={c.status} />{c.last_sync_error && <div className="mt-1 text-xs text-red-700">{c.last_sync_error.slice(0, 80)}</div>}</td>
                  <td className="tabular-nums">{c.score ?? "–"}</td>
                  <td>{c.open_incidents ? <span>{c.top_cause ? CAUSE_LABELS[c.top_cause as Cause]?.title : "Under analysis"}</span> : <span className="muted">None</span>}</td>
                  <td className="tabular-nums">{c.open_issues}</td>
                  <td className="muted">{fmtDate(c.last_synced_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {acc.canManage && (
        <Card title="Invite a client to connect their account">
          <p className="muted mb-3 text-sm">Your client authorizes Pinterest themselves after reading what PinInova accesses. You never handle their password or tokens. A consent record is kept for every connection.</p>
          <ConsentLinkForm ws={ws} />
          {data.consentLinks.length > 0 && (
            <table className="data mt-4"><thead><tr><th>Created</th><th>Client</th><th>Status</th></tr></thead><tbody>
              {data.consentLinks.map((l) => <tr key={l.id}><td>{fmtDate(l.created_at)}</td><td>{l.client_email ?? "–"}</td><td>{l.used_at ? `Used ${fmtDate(l.used_at)}` : l.expires_at < new Date() ? "Expired" : `Open until ${fmtDate(l.expires_at)}`}</td></tr>)}
            </tbody></table>
          )}
        </Card>
      )}
    </div>
  );
}
