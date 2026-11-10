"use client";
import { useActionState } from "react";
import type { ActionState } from "@/app/app/actions";
import * as A from "@/app/app/actions";

function Result({ s }: { s: ActionState }) {
  if (!s) return null;
  if (s.error) return <p role="alert" className="mt-2 text-sm text-red-700">{s.error}</p>;
  if (s.message) return <p role="status" className="mt-2 break-all text-sm text-green-800">{s.message}</p>;
  return null;
}

export function OnboardingForm() {
  const [s, act, pending] = useActionState(A.createOrgAndWorkspace, null);
  return (
    <form action={act} className="space-y-4">
      <div><label className="label" htmlFor="org">Your business or agency name</label><input className="input" id="org" name="org" required minLength={2} defaultValue="My PinInova" /></div>
      <div><label className="label" htmlFor="workspace">First workspace</label><input className="input" id="workspace" name="workspace" required defaultValue="My Pinterest" />
        <p className="muted mt-1 text-xs">One workspace per Pinterest client. Clients never see each other's data.</p></div>
      <fieldset><legend className="label">This workspace is for</legend>
        <label className="mr-4 text-sm"><input type="radio" name="kind" value="own" defaultChecked /> My own account</label>
        <label className="text-sm"><input type="radio" name="kind" value="client" /> A client</label></fieldset>
      <div><label className="label" htmlFor="niche">Niche (optional)</label>
        <select className="input" id="niche" name="niche" defaultValue=""><option value="">–</option>{["food", "home", "diy", "fashion", "beauty", "travel", "parenting", "finance", "wedding", "health", "art", "ecommerce", "other"].map((n) => <option key={n}>{n}</option>)}</select></div>
      <button className="btn-primary" disabled={pending}>Create workspace</button>
      <Result s={s} />
    </form>
  );
}

export function ConsentLinkForm({ ws }: { ws: string }) {
  const [s, act, pending] = useActionState(A.createConsentLink, null);
  return (
    <form action={act} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="ws" value={ws} />
      <div className="grow"><label className="label" htmlFor="cemail">Client email (optional, for your records)</label><input className="input" id="cemail" name="email" type="email" /></div>
      <button className="btn-secondary" disabled={pending}>Create consent link</button>
      <div className="w-full"><Result s={s} />{s?.ok && <p className="muted text-xs">Send this link to your client. It works once and expires in 14 days. They will see exactly what is accessed before connecting.</p>}</div>
    </form>
  );
}

export function ShareForm({ ws, report, shared }: { ws: string; report: string; shared: boolean }) {
  const [s, act, pending] = useActionState(A.shareReport, null);
  return (
    <form action={act} className="inline">
      <input type="hidden" name="ws" value={ws} /><input type="hidden" name="report" value={report} />
      <button className="btn-secondary" name="op" value="share" disabled={pending}>{shared ? "New share link" : "Share link"}</button>
      {shared && <button className="btn-danger ml-2" name="op" value="revoke" disabled={pending}>Revoke link</button>}
      <Result s={s} />
    </form>
  );
}

export function AlertSettingsForm({ ws, sensitivity, emails, slack, slackAllowed }: { ws: string; sensitivity: number; emails: string[]; slack: boolean; slackAllowed: boolean }) {
  const [s, act, pending] = useActionState(A.saveAlertSettings, null);
  return (
    <form action={act} className="space-y-4">
      <input type="hidden" name="ws" value={ws} />
      <div>
        <label className="label" htmlFor="sens">Sensitivity</label>
        <input id="sens" name="sensitivity" type="range" min="0.05" max="0.95" step="0.05" defaultValue={sensitivity} className="w-full" aria-describedby="sens-help" />
        <p id="sens-help" className="muted text-xs">Left: fewer alerts, only high-confidence causes. Right: more alerts, earlier, including lower-confidence causes. Sets the cost ratio of a missed problem to a false alarm.</p>
      </div>
      <div><label className="label" htmlFor="emails">Alert emails (comma-separated)</label><input className="input" id="emails" name="emails" defaultValue={emails.join(", ")} /></div>
      <div>
        <label className="label" htmlFor="slack">Slack incoming webhook URL</label>
        <input className="input" id="slack" name="slack" placeholder={slack ? "•••••• saved (encrypted) — paste to replace" : "https://hooks.slack.com/services/…"} disabled={!slackAllowed} />
        {!slackAllowed && <p className="muted text-xs">Slack alerts are on the Pro and Agency plans.</p>}
        {slack && <label className="mt-1 block text-xs"><input type="checkbox" name="slack_clear" value="1" /> Remove the saved webhook</label>}
      </div>
      <button className="btn-primary" disabled={pending}>Save</button>
      <Result s={s} />
    </form>
  );
}

export function CsvImportForm({ ws, conn }: { ws: string; conn: string }) {
  const [s, act, pending] = useActionState(A.importCsvAction, null);
  return (
    <form action={act} className="space-y-2">
      <input type="hidden" name="ws" value={ws} /><input type="hidden" name="conn" value={conn} />
      <label className="label" htmlFor="csvfile">Pinterest Analytics CSV export (up to ~1.5 years)</label>
      <input id="csvfile" name="file" type="file" accept=".csv,text/csv" required className="text-sm" />
      <button className="btn-secondary" disabled={pending}>{pending ? "Importing…" : "Import history"}</button>
      <Result s={s} />
    </form>
  );
}

type Finding = { rule_id: string; severity: string; source: string; draft_index: number | null; message: string; policy_ref: string };
export function PreflightForm({ ws, conns }: { ws: string; conns: { id: string; username: string }[] }) {
  const [s, act, pending] = useActionState(A.preflightAction, null);
  const data = s?.data as { drafts: { title: string }[]; findings: Finding[]; warnings: string[] } | undefined;
  return (
    <div>
      <form action={act} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="ws" value={ws} />
        <div><label className="label" htmlFor="pfconn">Compare with account history</label>
          <select className="input" id="pfconn" name="conn"><option value="">None</option>{conns.map((c) => <option key={c.id} value={c.id}>@{c.username}</option>)}</select></div>
        <div><label className="label" htmlFor="pffile">Drafts CSV (title, description, link, board, scheduled_at)</label><input id="pffile" name="file" type="file" accept=".csv" required className="text-sm" /></div>
        <button className="btn-primary" disabled={pending}>Check drafts</button>
      </form>
      <Result s={s} />
      {data && (
        <div className="mt-4">
          <p className="text-sm">{data.drafts.length} drafts checked · {data.findings.length} findings</p>
          <table className="data mt-2"><thead><tr><th>Draft</th><th>Finding</th><th>Severity</th><th>Basis</th></tr></thead><tbody>
            {data.findings.map((f, i) => (
              <tr key={i}><td>{f.draft_index !== null ? `#${f.draft_index + 1} ${data.drafts[f.draft_index]?.title ?? ""}` : "All"}</td><td>{f.message}</td><td>{f.severity}</td>
                <td><span className="text-xs">{f.source === "official" ? "Pinterest policy" : f.source === "vendor" ? "Vendor guidance" : "Hypothesis"}</span><br /><span className="muted text-xs">{f.policy_ref}</span></td></tr>
            ))}
          </tbody></table>
        </div>
      )}
    </div>
  );
}

export function LeakForm({ ws, conn, mockAllowed }: { ws: string; conn: string; mockAllowed: boolean }) {
  const [s, act, pending] = useActionState(A.leakAction, null);
  const r = s?.data as { leakRatio: number; ga4PinterestSessions: number; ga4DirectSessionsOnPinPages: number; pinterestOutboundClicks: number; sessionsPerClick: number | null; autoUtmSeen: boolean; source: string } | undefined;
  return (
    <div>
      <form action={act} className="flex flex-wrap items-end gap-3">
        <input type="hidden" name="ws" value={ws} /><input type="hidden" name="conn" value={conn} />
        <div><label className="label" htmlFor="ga4file">GA4 export CSV (date, session source / medium, landing page, sessions)</label><input id="ga4file" name="file" type="file" accept=".csv" className="text-sm" /></div>
        <button className="btn-primary" name="mode" value="csv" disabled={pending}>Run leak check</button>
        {mockAllowed && <button className="btn-secondary" name="mode" value="mock" disabled={pending}>Run with simulated GA4 data</button>}
      </form>
      <Result s={s} />
      {r && (
        <div className="mt-3 grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <div><div className="muted text-xs">Pinterest outbound clicks</div><b>{r.pinterestOutboundClicks.toLocaleString()}</b></div>
          <div><div className="muted text-xs">GA4 sessions from Pinterest</div><b>{r.ga4PinterestSessions.toLocaleString()}</b></div>
          <div><div className="muted text-xs">GA4 "Direct" on Pin landing pages</div><b>{r.ga4DirectSessionsOnPinPages.toLocaleString()}</b></div>
          <div><div className="muted text-xs">Likely mislabelled share</div><b>{Math.round(r.leakRatio * 100)}%</b></div>
          <p className="col-span-full muted text-xs">{r.source === "mock" ? "SIMULATED GA4 data. " : ""}{r.autoUtmSeen ? "Pinterest's automatic organic UTMs are present." : "No utm_medium=organic from Pinterest seen: check the \"Apply URL parameters\" setting in Pinterest Business settings."}</p>
        </div>
      )}
    </div>
  );
}

export function TokensForm({ ws, conn, links }: { ws: string; conn: string; links: string[] }) {
  const [s, act, pending] = useActionState(A.tokensAction, null);
  const out = s?.data as { label: string; token: string; url: string }[] | undefined;
  return (
    <div>
      <form action={act} className="space-y-2">
        <input type="hidden" name="ws" value={ws} /><input type="hidden" name="conn" value={conn} />
        <label className="label" htmlFor="links">New Pins to tag (one per line: <code>label | https://url</code>)</label>
        <textarea className="input font-mono text-xs" id="links" name="links" rows={4} defaultValue={links.slice(0, 3).map((l, i) => `New Pin ${i + 1} | ${l}`).join("\n")} />
        <button className="btn-secondary" disabled={pending}>Generate tagged links</button>
      </form>
      <Result s={s} />
      {out && <table className="data mt-2"><thead><tr><th>Label</th><th>Use this link on the new Pin</th></tr></thead><tbody>{out.map((o) => <tr key={o.token}><td>{o.label}</td><td className="break-all font-mono text-xs">{o.url}</td></tr>)}</tbody></table>}
    </div>
  );
}

export function OrdersForm({ ws, conn }: { ws: string; conn: string }) {
  const [s, act, pending] = useActionState(A.ordersAction, null);
  return (
    <form action={act} className="flex flex-wrap items-end gap-3">
      <input type="hidden" name="ws" value={ws} /><input type="hidden" name="conn" value={conn} />
      <div><label className="label" htmlFor="ofile">Shopify orders export CSV</label><input id="ofile" name="file" type="file" accept=".csv" required className="text-sm" /></div>
      <button className="btn-secondary" disabled={pending}>Import orders</button>
      <div className="w-full"><Result s={s} /></div>
    </form>
  );
}

export function GrantViewerForm({ ws }: { ws: string }) {
  const [s, act, pending] = useActionState(A.grantViewerAction, null);
  return (
    <form action={act} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="ws" value={ws} />
      <div className="grow"><label className="label" htmlFor="vemail">Client's email</label><input className="input" id="vemail" name="email" type="email" required /></div>
      <button className="btn-secondary" disabled={pending}>Send read-only invitation</button>
      <div className="w-full"><Result s={s} /></div>
    </form>
  );
}
