import { Card, Empty, fmtDate } from "@/components/ui";
import { GrantViewerForm } from "@/components/Forms";
import { requireUser } from "@/modules/auth/session";
import { settingsData } from "@/modules/queries";
import { asUser } from "@/modules/workspaces/access";
import { env } from "@/env";

export default async function SettingsPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const user = await requireUser();
  const d = await asUser(user.id, ws, (tx) => settingsData(tx), { manage: true });
  const e = env();
  return (
    <div className="space-y-6">
      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Client access">
          <p className="muted mb-3 text-sm">Give a client read-only access to this workspace only. They see its accounts and reports, never other clients.</p>
          <GrantViewerForm ws={ws} />
          {d.viewers.length > 0 && <ul className="mt-3 text-sm">{d.viewers.map((v) => <li key={v.user_id}>{v.email} · since {fmtDate(v.created_at)}</li>)}</ul>}
        </Card>
        <Card title="Your data">
          <ul className="space-y-1 text-sm">
            <li>Daily numbers are kept for {e.RETENTION_RAW_DAYS} days; PinInova's own analysis for {e.RETENTION_DERIVED_DAYS} days.</li>
            <li>Pin titles, descriptions and images are never stored.</li>
            <li>Disconnecting an account deletes its data within 24 hours.</li>
          </ul>
          <a className="btn-secondary mt-3" href={`/api/export/${ws}`}>Download all data (JSON)</a>
        </Card>
      </div>
      <Card title="Consent records">
        {d.consents.length === 0 ? <Empty>None yet.</Empty> : (
          <table className="data"><thead><tr><th>Account</th><th>Granted</th><th>Via</th><th>Scopes</th><th>Consent text</th><th>Revoked</th></tr></thead><tbody>
            {d.consents.map((c) => <tr key={c.id}><td>{c.pinterest_username === "purged" ? <span className="muted">deleted</span> : `@${c.pinterest_username}`}</td><td>{fmtDate(c.granted_at)}</td><td>{c.granted_via === "client_link" ? "Client consent link" : "Owner"}</td><td className="text-xs">{c.scopes.join(", ")}</td><td className="text-xs">{c.consent_text_version}</td><td>{fmtDate(c.revoked_at)}</td></tr>)}
          </tbody></table>
        )}
      </Card>
      <Card title="Deletions">
        {d.deletions.length === 0 ? <Empty>No deletions.</Empty> : (
          <table className="data"><thead><tr><th>Requested</th><th>Reason</th><th>Completed</th><th>Rows deleted</th></tr></thead><tbody>
            {d.deletions.map((x) => <tr key={x.connection_id + x.requested_at.toISOString()}><td>{fmtDate(x.requested_at)}</td><td>{x.reason}</td><td>{fmtDate(x.completed_at)}</td><td className="text-xs">{x.rows_deleted ? Object.values(x.rows_deleted).reduce((a, b) => a + Number(b), 0) : "pending"}</td></tr>)}
          </tbody></table>
        )}
      </Card>
      <Card title="Audit log">
        <table className="data"><thead><tr><th>When</th><th>Who</th><th>Action</th></tr></thead><tbody>
          {d.auditLog.map((a) => <tr key={String(a.id)}><td className="whitespace-nowrap">{a.at.toISOString().replace("T", " ").slice(0, 16)}</td><td className="max-w-40 truncate text-xs">{a.actor}</td><td>{a.action}</td></tr>)}
        </tbody></table>
      </Card>
    </div>
  );
}
