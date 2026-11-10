import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, Chip, SourceChip, StatusChip, fmtDate, fmtPct } from "@/components/ui";
import { requireUser } from "@/modules/auth/session";
import { CAUSE_LABELS, type Cause } from "@/modules/health/analytics-client";
import { incidentDetail } from "@/modules/queries";
import { asUser } from "@/modules/workspaces/access";
import { evidencePackAction, incidentFeedback } from "@/app/app/actions";

const DONT: Record<string, string[]> = {
  D_platform: ["Don't mass-delete or rewrite Pins: nothing in your account changed.", "Keep publishing at your normal pace.", "File one well-evidenced ticket, not several: Pinterest caps appeals."],
  A_enforcement: ["Don't create new Pins to the affected domain until the link checks pass.", "Don't swap Pin links in bulk to another domain: changing destinations can itself be treated as spam."],
  C_behavioural: ["Don't bulk-upload or schedule the same URL repeatedly.", "Don't re-post the same image to many boards."],
  B_quality: ["Don't delete low performers in bulk (Pinterest's partners advise against it).", "Fix the landing pages first: speed, content match, working links."],
  E_decay: ["Don't treat this as a penalty: a top Pin fading is normal.", "Create fresh Pins for the same evergreen URLs, spaced at least a week apart."],
  M_measurement: ["Don't change your Pinterest strategy based on analytics alone: check the GA4 leak first."],
};

export default async function IncidentPage({ params }: { params: Promise<{ ws: string; conn: string; id: string }> }) {
  const { ws, conn, id } = await params;
  const user = await requireUser();
  const { d, acc } = await asUser(user.id, ws, async (tx, acc) => ({ d: await incidentDetail(tx, id), acc }));
  if (!d) notFound();
  const r = d.incident.result;
  const top = r.classes?.[0];
  const label = top ? CAUSE_LABELS[top.cause as Cause] : null;
  return (
    <div className="space-y-6">
      <Link href={`/app/w/${ws}/a/${conn}`} className="text-sm hover:underline">← Back to account</Link>
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl">{d.incident.status === "drop" ? "Reach drop" : "Early warning"} since {d.incident.onset_date ?? d.incident.warning_date}</h2>
        <StatusChip status={d.incident.state} />
        <Chip>{d.incident.tier.replace(/_/g, " ")}</Chip>
      </div>
      <div className="grid gap-6 md:grid-cols-3">
        <Card title="Most likely cause" className="md:col-span-2">
          {label ? (
            <>
              <div className="flex flex-wrap items-center gap-2"><span className="text-lg font-semibold">{label.title}</span><SourceChip source={label.source} /><span className="muted text-sm">{fmtPct(top!.probability)} · {r.confidence} confidence</span></div>
              <p className="mt-2">{label.short}</p>
              <h3 className="mt-4 text-sm font-semibold">Why we think so</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{r.evidence.map((e, i) => <li key={i}>{e.text}</li>)}</ul>
              <h3 className="mt-4 text-sm font-semibold">What not to waste time on</h3>
              <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">{(DONT[top!.cause] ?? []).map((t) => <li key={t}>{t}</li>)}</ul>
              <p className="muted mt-4 text-xs">This is a likely explanation from this account's own numbers, not a confirmation from Pinterest. PinInova does not promise recovery.</p>
            </>
          ) : <p>Not enough data to name a cause yet. We re-analyse after each sync.</p>}
        </Card>
        <Card title="All causes considered">
          <ul className="space-y-2 text-sm">{r.classes.map((c) => (
            <li key={c.cause}><div className="flex justify-between"><span>{CAUSE_LABELS[c.cause as Cause]?.title ?? c.cause}</span><span className="tabular-nums">{fmtPct(c.probability)}</span></div>
              <div className="mt-1 h-1.5 rounded bg-stone-200" aria-hidden><div className="h-1.5 rounded bg-brand-700" style={{ width: `${Math.round(c.probability * 100)}%` }} /></div></li>
          ))}</ul>
        </Card>
      </div>
      <div className="grid gap-6 md:grid-cols-3">
        <Card title="Size and timing">
          <dl className="grid grid-cols-2 gap-y-1 text-sm">
            <dt className="muted">Before (median/day)</dt><dd className="tabular-nums">{r.drop ? Math.round(r.drop.before_median).toLocaleString() : "–"}</dd>
            <dt className="muted">After (median/day)</dt><dd className="tabular-nums">{r.drop ? Math.round(r.drop.after_median).toLocaleString() : "–"}</dd>
            <dt className="muted">Drop</dt><dd>{r.drop ? `${Math.round(r.drop.effect * 100)}%` : "–"}</dd>
            <dt className="muted">Shape</dt><dd>{r.shape}</dd>
            <dt className="muted">Methods agree</dt><dd>{r.methods_agree ? "yes" : "no"}</dd>
            <dt className="muted">q-value</dt><dd className="tabular-nums">{d.incident.q_value?.toFixed(3) ?? "–"}</dd>
            <dt className="muted">Detector</dt><dd className="text-xs">{d.incident.detector_version}</dd>
          </dl>
        </Card>
        <Card title="Engagement per view">
          <p className="text-sm">{r.rate.verdict === "stable" ? "Click-through rate held while impressions fell: Pins are shown less, not performing worse." : r.rate.verdict === "changed" ? "Click-through rate changed with the drop: content or audience changed too." : "Not enough post-drop impressions yet to tell."}</p>
          <p className="muted mt-2 text-sm">Before {fmtPct(r.rate.ctr_before, 2)} · after {fmtPct(r.rate.ctr_after, 2)}</p>
        </Card>
        <Card title="Where the drop is">
          <table className="data"><tbody>
            {Object.entries(r.breadth.age ?? {}).map(([k, v]) => <tr key={k}><td>Pins aged {k} days</td><td className="tabular-nums">{fmtPct(v)} of before</td></tr>)}
            {(r.breadth.domains ?? []).map((x) => <tr key={x.domain}><td>Links to {x.domain}</td><td className="tabular-nums">{fmtPct(x.ratio)}</td></tr>)}
            {r.breadth.unlinked_ratio !== null && <tr><td>Pins without links</td><td className="tabular-nums">{fmtPct(r.breadth.unlinked_ratio)}</td></tr>}
          </tbody></table>
        </Card>
      </div>
      {r.pin_contributions.length > 0 && (
        <Card title="Which Pins drove it">
          <table className="data"><thead><tr><th>Pin</th><th>Change in impressions (14 days)</th><th>Share of the drop</th></tr></thead><tbody>
            {r.pin_contributions.slice(0, 10).map((p) => <tr key={p.pin_id}><td className="font-mono text-xs">{p.pin_id}</td><td className="tabular-nums">{Math.round(p.delta).toLocaleString()}</td><td className="tabular-nums">{fmtPct(p.share)}</td></tr>)}
          </tbody></table>
          {r.concentration.top1_share !== null && <p className="muted mt-2 text-xs">Before the drop, the top 1% of Pins carried {fmtPct(r.concentration.top1_share)} of impressions.</p>}
        </Card>
      )}
      {acc.canManage && (
        <div className="grid gap-6 md:grid-cols-2">
          <Card title="Your verdict">
            <form action={incidentFeedback} className="space-y-2">
              <input type="hidden" name="ws" value={ws} /><input type="hidden" name="incident" value={id} />
              <label className="label" htmlFor="cause">What actually happened (improves future diagnoses)</label>
              <select className="input" id="cause" name="cause" defaultValue={d.incident.user_cause ?? ""}><option value="">Not sure yet</option>{Object.entries(CAUSE_LABELS).map(([k, v]) => <option key={k} value={k}>{v.title}</option>)}</select>
              <div className="flex gap-2"><button className="btn-secondary" name="state" value="acknowledged">Acknowledge</button><button className="btn-secondary" name="state" value="resolved">Mark resolved</button></div>
            </form>
          </Card>
          <Card title="Evidence pack for Pinterest support">
            <p className="muted mb-2 text-sm">A dated summary with the timeline, findings, link checks and a suggested ticket text for Pinterest's creator-stats-drop category. Pinterest limits how many appeals one person can file: submit one good ticket.</p>
            <form action={evidencePackAction}><input type="hidden" name="ws" value={ws} /><input type="hidden" name="incident" value={id} /><button className="btn-primary">Build evidence pack</button></form>
            {d.reports.length > 0 && <p className="mt-2 text-sm">Previous: {d.reports.map((x) => <Link key={x.id} className="underline" href={`/app/w/${ws}/reports`}>{fmtDate(x.created_at)}</Link>)}</p>}
          </Card>
        </div>
      )}
    </div>
  );
}
