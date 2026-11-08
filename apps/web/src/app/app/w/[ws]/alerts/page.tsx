import { Card, Chip, Empty, fmtDate } from "@/components/ui";
import { AlertSettingsForm } from "@/components/Forms";
import { requireUser } from "@/modules/auth/session";
import { alertSettingsAndHistory } from "@/modules/queries";
import { asUser } from "@/modules/workspaces/access";
import { entitlements } from "@/modules/billing/plans";
import { alertFeedback } from "@/app/app/actions";

export default async function AlertsPage({ params }: { params: Promise<{ ws: string }> }) {
  const { ws } = await params;
  const user = await requireUser();
  const { d, acc } = await asUser(user.id, ws, async (tx, acc) => ({ d: await alertSettingsAndHistory(tx), acc }), { manage: true });
  const ent = await entitlements(acc.orgId);
  return (
    <div className="grid gap-6 md:grid-cols-3">
      <Card title="Alert settings">
        <AlertSettingsForm ws={ws} sensitivity={d.settings.sensitivity} emails={d.settings.emails} slack={d.settings.slack} slackAllowed={ent.slack} />
        <div className="muted mt-4 space-y-1 text-xs">
          <p><b>Early warning</b>: in-app only, while a drop is still being confirmed.</p>
          <p><b>Drop detected</b>: two independent methods agree and the drop survives a false-discovery check across this workspace's accounts. Email.</p>
          <p><b>Action needed</b>: a drop whose likely cause is something you can act on. Email and Slack.</p>
        </div>
      </Card>
      <Card title="Alert history" className="md:col-span-2">
        {d.history.length === 0 ? <Empty>No alerts yet.</Empty> : (
          <table className="data"><thead><tr><th>When</th><th>Alert</th><th>Channel</th><th>Useful?</th></tr></thead><tbody>
            {d.history.map((a) => (
              <tr key={a.id}><td>{fmtDate(a.created_at)}</td><td>{a.title}{a.delivery_error && <div className="text-xs text-red-700">{a.delivery_error}</div>}</td><td><Chip>{a.channel}</Chip></td>
                <td>{a.useful === null ? (
                  <form action={alertFeedback} className="inline-flex gap-1"><input type="hidden" name="ws" value={ws} /><input type="hidden" name="alert" value={a.id} />
                    <button className="btn-secondary !px-2 !py-0.5 text-xs" name="useful" value="1" aria-label="Useful">Yes</button><button className="btn-secondary !px-2 !py-0.5 text-xs" name="useful" value="0" aria-label="Not useful">No</button></form>
                ) : a.useful ? "Yes" : "No"}</td></tr>
            ))}
          </tbody></table>
        )}
        {d.outbox.length > 0 && <details className="mt-4 text-sm"><summary className="muted cursor-pointer">Email log ({d.outbox[0]!.transport === "outbox" ? "outbox transport: not sent externally" : "Resend"})</summary>
          <ul className="mt-2">{d.outbox.map((o) => <li key={o.id}>{fmtDate(o.created_at)} → {o.to_address}: {o.subject} {o.sent_at ? "✓" : "…"}</li>)}</ul></details>}
      </Card>
    </div>
  );
}
