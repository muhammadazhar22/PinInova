import { Card, Empty, fmtDate, fmtInt } from "@/components/ui";
import { LeakForm, OrdersForm, TokensForm } from "@/components/Forms";
import { env } from "@/env";
import { requireUser } from "@/modules/auth/session";
import { revenueByToken } from "@/modules/attribution/shopify";
import { attributionData } from "@/modules/queries";
import { asUser } from "@/modules/workspaces/access";

export default async function AttributionPage({ params, searchParams }: { params: Promise<{ ws: string }>; searchParams: Promise<{ conn?: string }> }) {
  const { ws } = await params;
  const sp = await searchParams;
  const user = await requireUser();
  const conns = await asUser(user.id, ws, (tx) => tx<{ id: string; username: string }[]>`SELECT id, username FROM pinterest_connection WHERE status = 'active' ORDER BY created_at`, { manage: true });
  const conn = conns.find((c) => c.id === sp.conn) ?? conns[0];
  if (!conn) return <Empty>Connect a Pinterest account first.</Empty>;
  const d = await asUser(user.id, ws, (tx) => attributionData(tx, conn.id));
  const rev = await revenueByToken(ws, conn.id);
  const e = env();
  return (
    <div className="space-y-6">
      <p role="note" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        <b>Not production-ready.</b> GA4 and Shopify are supported through CSV exports you upload. Direct API connections are not built or approved yet (GA4 mode: {e.GA4_MODE}, Shopify mode: {e.SHOPIFY_MODE}).
        Only order totals, dates and UTM fields are read; no customer data.
      </p>
      {conns.length > 1 && <form className="flex items-end gap-2"><label className="label" htmlFor="c">Account</label><select className="input max-w-xs" id="c" name="conn" defaultValue={conn.id}>{conns.map((c) => <option key={c.id} value={c.id}>@{c.username}</option>)}</select><button className="btn-secondary">Switch</button></form>}
      <Card title={`Traffic Leak Check · @${conn.username}`}>
        <p className="muted mb-3 text-sm">GA4 can file Pinterest app visits as "Direct". This compares Pinterest's outbound clicks with GA4 sessions on your Pin landing pages.</p>
        <LeakForm ws={ws} conn={conn.id} mockAllowed={e.GA4_MODE === "mock" || e.PINTEREST_MODE === "mock"} />
        {d.leaks.length > 0 && (
          <table className="data mt-4"><thead><tr><th>Run</th><th>Period</th><th>Clicks</th><th>GA4 Pinterest</th><th>GA4 Direct on Pin pages</th><th>Mislabelled share</th><th>Source</th></tr></thead><tbody>
            {d.leaks.map((l) => <tr key={l.id}><td>{fmtDate(l.created_at)}</td><td>{l.period_start} – {l.period_end}</td><td>{fmtInt(l.pinterest_outbound_clicks)}</td><td>{fmtInt(l.ga4_pinterest_sessions)}</td><td>{fmtInt(l.ga4_direct_sessions)}</td><td>{l.leak_ratio !== null ? `${Math.round(l.leak_ratio * 100)}%` : "–"}</td><td>{l.source === "mock" ? "simulated" : "CSV"}</td></tr>)}
          </tbody></table>
        )}
      </Card>
      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Tag new Pins for revenue tracking">
          <p className="muted mb-3 text-sm">Each new Pin gets a unique <code>utm_content</code> token. Revenue can only be attributed to Pins tagged from now on; past Pins and organic search keywords cannot be attributed.</p>
          <TokensForm ws={ws} conn={conn.id} links={d.links} />
        </Card>
        <Card title="Revenue by tagged Pin">
          <OrdersForm ws={ws} conn={conn.id} />
          {rev.rows.length > 0 ? (
            <table className="data mt-3"><thead><tr><th>Pin</th><th>Token</th><th>Orders</th><th>Revenue</th></tr></thead><tbody>
              {rev.rows.map((r) => <tr key={r.token}><td>{r.label}</td><td className="font-mono text-xs">{r.token}</td><td className="tabular-nums">{r.orders}</td><td className="tabular-nums">{r.revenue.toFixed(2)} {r.currency ?? ""}</td></tr>)}
            </tbody></table>
          ) : <p className="muted mt-3 text-sm">No tagged Pins yet.</p>}
          {rev.untaggedRevenue > 0 && <p className="muted mt-2 text-xs">Untagged order revenue imported: {rev.untaggedRevenue.toFixed(2)} (not attributed to any Pin).</p>}
        </Card>
      </div>
    </div>
  );
}
