import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, Chip, Empty, ScoreRing, SourceChip, StatusChip, fmtDate, fmtPct } from "@/components/ui";
import { TimelineChart } from "@/components/TimelineChart";
import { CsvImportForm } from "@/components/Forms";
import { requireUser } from "@/modules/auth/session";
import { CAUSE_LABELS, type Cause } from "@/modules/health/analytics-client";
import { accountDetail } from "@/modules/queries";
import { asUser } from "@/modules/workspaces/access";
import { buildReportAction, disconnectAction, issueAction, recordObserved, runChecksNow, syncNow } from "@/app/app/actions";

const SUB_LABELS: Record<string, string> = { distribution: "Distribution", link_quality: "Link quality", domain_trust: "Domain trust", content_integrity: "Content integrity", cadence: "Cadence" };

export default async function AccountPage({ params }: { params: Promise<{ ws: string; conn: string }> }) {
  const { ws, conn } = await params;
  const user = await requireUser();
  const { d, acc } = await asUser(user.id, ws, async (tx, acc) => ({ d: await accountDetail(tx, conn), acc }));
  if (!d) notFound();
  const hidden = (<><input type="hidden" name="ws" value={ws} /><input type="hidden" name="conn" value={conn} /></>);
  const markers = d.incidents.filter((i) => i.onset_date || i.warning_date).map((i) => ({ date: (i.onset_date ?? i.warning_date)!, label: i.status === "drop" ? "drop" : "warning", kind: i.status as "drop" | "warning" }));
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl">@{d.conn.username}</h2>
        <StatusChip status={d.conn.status} />
        {d.conn.mode === "mock" && <Chip tone="warn">mock data</Chip>}
        <span className="muted text-sm">Last sync {fmtDate(d.conn.last_synced_at)}</span>
        {acc.canManage && d.conn.status === "active" && (
          <div className="ml-auto flex gap-2">
            <form action={syncNow}>{hidden}<button className="btn-secondary">Sync now</button></form>
            <form action={runChecksNow}>{hidden}<button className="btn-secondary">Run link checks</button></form>
            <form action={buildReportAction}>{hidden}<button className="btn-primary">Monthly report</button></form>
          </div>
        )}
        {d.conn.status === "needs_reauth" && acc.canManage && <a className="btn-primary ml-auto" href={`/api/pinterest/connect?ws=${ws}`}>Reconnect</a>}
      </div>

      <div className="grid gap-6 md:grid-cols-3">
        <Card title="Health">
          <ScoreRing score={d.health?.score ?? null} />
          {d.health && (
            <ul className="mt-4 space-y-1 text-sm">
              {Object.entries(d.health.subgrades).map(([k, v]) => <li key={k} className="flex justify-between"><span>{SUB_LABELS[k] ?? k}</span><span className="tabular-nums">{v ?? "n/a"}</span></li>)}
            </ul>
          )}
          <details className="mt-3 text-xs"><summary className="muted cursor-pointer">How the score is calculated</summary>
            <p className="mt-1">The mean of the available sub-grades, capped at the weakest sub-grade + 10 so one severe problem is never averaged away. Distribution: 100 without a drop, 65 during an early warning, and 100 × (1 − drop size) capped at 60 during a confirmed drop. Link quality: share of sampled Pin links loading in under 4 s with at most one redirect. Domain trust: −25 per unclaimed linked domain, −40 per robots.txt blocking Pinterestbot. Content integrity: share of recent Pins not reusing another Pin's image. Cadence: −15 per week with more than 3× your usual new Pins.</p></details>
        </Card>
        <Card title="Daily impressions" className="md:col-span-2">
          {d.series.dates.length ? <TimelineChart dates={d.series.dates} impressions={d.series.impressions} clicks={d.series.clicks} markers={markers} provisional={d.series.provisional} /> : <Empty>No data yet. The first sync pulls 90 days.</Empty>}
        </Card>
      </div>

      <Card title="Incidents">
        {d.incidents.length === 0 ? <Empty>No drops detected.</Empty> : (
          <div className="space-y-3">
            {d.incidents.map((i) => {
              const top = i.result.classes?.[0];
              const label = top ? CAUSE_LABELS[top.cause as Cause] : null;
              return (
                <Link key={i.id} href={`/app/w/${ws}/a/${conn}/incidents/${i.id}`} className="block rounded-lg border border-stone-200 p-4 hover:border-brand-600">
                  <div className="flex flex-wrap items-center gap-2">
                    <Chip tone={i.status === "drop" ? "bad" : "warn"}>{i.status === "drop" ? `Drop ${i.effect !== null ? `−${Math.round(i.effect * 100)}%` : ""}` : "Early warning"}</Chip>
                    <span className="font-medium">{label?.title ?? "Cause not yet determined"}</span>
                    {top && <span className="muted text-sm">{fmtPct(top.probability)} · {i.confidence} confidence</span>}
                    {label && <SourceChip source={label.source} />}
                    <span className="muted ml-auto text-sm">since {i.onset_date ?? i.warning_date}</span>
                    <StatusChip status={i.state} />
                  </div>
                  {label && <p className="muted mt-1 text-sm">{label.short}</p>}
                </Link>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Issues">
        {d.issues.length === 0 ? <Empty>No issues found by the latest checks.</Empty> : (
          <table className="data"><thead><tr><th>Issue</th><th>Whose to fix</th><th>Count</th><th>First seen</th><th>State</th>{acc.canManage && <th />}</tr></thead><tbody>
            {d.issues.map((s) => (
              <tr key={s.id}>
                <td><span className={s.severity === "error" ? "text-red-800" : ""}>{s.title}</span></td>
                <td><SourceChip source={s.source} /></td><td className="tabular-nums">{s.affected_count}</td><td>{fmtDate(s.first_seen)}</td><td><StatusChip status={s.state} /></td>
                {acc.canManage && <td className="whitespace-nowrap">
                  <form action={issueAction} className="inline"><input type="hidden" name="ws" value={ws} /><input type="hidden" name="issue" value={s.id} />
                    {["open", "regressed", "failed"].includes(s.state) && s.source === "you" && <button className="btn-secondary !py-1 text-xs" name="op" value="validate" title="I fixed it — re-check over the next 2–4 weeks">I fixed this</button>}
                    {s.state !== "suppressed" ? <button className="btn-secondary ml-1 !py-1 text-xs" name="op" value="suppress" title="Known false positive for this client">Suppress</button> : <button className="btn-secondary !py-1 text-xs" name="op" value="reopen">Reopen</button>}
                  </form></td>}
              </tr>
            ))}
          </tbody></table>
        )}
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Link and domain checks">
          {d.checks.length === 0 ? <Empty>Not run yet.</Empty> : (
            <table className="data"><thead><tr><th>Link</th><th>Status</th><th>Load</th><th>robots.txt</th></tr></thead><tbody>
              {d.checks.map((c, i) => <tr key={i}><td className="max-w-56 truncate" title={c.url}>{c.url.replace(/^https?:\/\//, "")}</td><td>{c.http_status ?? <span className="text-red-700">{c.error}</span>}{c.hops.length > 1 && <span className="muted text-xs"> · {c.hops.length} redirects</span>}</td><td className="tabular-nums">{c.total_ms ?? "–"} ms</td><td>{c.robots?.blocked ? <span className="text-red-700">blocks Pinterestbot</span> : (c.robots?.crawlDelay ?? 0) > 1 ? <span className="text-amber-700">crawl-delay {c.robots?.crawlDelay}</span> : "ok"}</td></tr>)}
            </tbody></table>
          )}
          <p className="muted mt-2 text-xs">Only this account's own Pin links are checked, at most one request per second per domain.</p>
        </Card>
        {acc.canManage && (
          <Card title="Tell us what you see in Pinterest">
            <p className="muted mb-2 text-sm">PinInova never logs into or scrapes Pinterest. If you see one of these in the Pinterest app, record it here; it feeds the diagnosis and the evidence pack.</p>
            <form action={recordObserved} className="space-y-2">{hidden}
              <select className="input" name="kind" aria-label="What you observed">
                <option value="visit_site_demoted">"Visit site" button missing or moved into the … menu</option>
                <option value="domain_block_error">"We blocked this link" error when saving</option>
                <option value="ai_label">"AI modified" label on Pins I made myself</option>
                <option value="search_invisible">My Pin doesn't appear when I search its exact title</option>
              </select>
              <input className="input" name="note" placeholder="Optional note (which Pin, when)" maxLength={500} />
              <button className="btn-secondary">Record</button>
            </form>
            {d.observed.length > 0 && <ul className="mt-3 text-sm">{d.observed.map((o) => <li key={o.id}>{o.observed_on}: {o.kind.replace(/_/g, " ")}{o.note ? ` — ${o.note}` : ""}</li>)}</ul>}
          </Card>
        )}
      </div>

      {acc.canManage && (
        <div className="grid gap-6 md:grid-cols-2">
          <Card title="Import history"><p className="muted mb-2 text-sm">The API only gives 90 days. Import your own Pinterest Analytics export to compare with last year.</p><CsvImportForm ws={ws} conn={conn} /></Card>
          <Card title="Disconnect">
            <p className="muted mb-2 text-sm">Destroys the stored tokens immediately and deletes all data for this account within 24 hours.</p>
            <form action={disconnectAction} className="flex items-end gap-2">{hidden}
              <div><label className="label" htmlFor="confirm">Type DELETE to confirm</label><input className="input" id="confirm" name="confirm" required pattern="DELETE" /></div>
              <button className="btn-danger">Disconnect and delete</button>
            </form>
          </Card>
        </div>
      )}
      <p className="muted text-xs">Claimed websites: {(d.conn.claimed_sites ?? []).map((s) => `${s.website} (${s.status ?? "?"})`).join(", ") || "none"} · <Link className="underline" href={`/app/w/${ws}/attribution?conn=${conn}`}>Attribution</Link></p>
    </div>
  );
}
