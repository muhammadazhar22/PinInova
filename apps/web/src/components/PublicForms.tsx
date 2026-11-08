"use client";
import { useActionState } from "react";
import { runDropCheck, submitWeather, type DropCheckState, type WeatherState } from "@/app/public-actions";
import { TimelineChart } from "./TimelineChart";

const CAUSE_TITLES: Record<string, string> = {
  A_enforcement: "Link or domain restriction", B_quality: "Quality down-ranking", C_behavioural: "Publishing pattern",
  D_platform: "Platform-side change", E_decay: "Normal decay of a top Pin", M_measurement: "Measurement artefact",
};

export function DropCheckForm() {
  const [s, act, pending] = useActionState<DropCheckState, FormData>(runDropCheck, null);
  const r = s?.result;
  return (
    <div className="space-y-6">
      <form action={act} className="card flex flex-wrap items-end gap-3">
        <div><label className="label" htmlFor="f">Pinterest Analytics CSV export</label><input id="f" name="file" type="file" accept=".csv,text/csv" required className="text-sm" /></div>
        <button className="btn-primary" disabled={pending}>{pending ? "Analysing…" : "Check my account"}</button>
        <p className="muted w-full text-xs">Your file is analysed in memory and not stored. Export at least 30 days (ideally 90+) from Pinterest Analytics → Overview → Export.</p>
      </form>
      {s?.error && <p role="alert" className="text-sm text-red-700">{s.error}</p>}
      {r && s?.days && (
        <div className="space-y-4">
          <div className="card">
            <h2>{r.status === "drop" ? `Reach dropped ${r.drop ? Math.round(r.drop.effect * 100) : "?"}% starting ${r.onset_date}` : r.status === "warning" ? `Impressions started falling around ${r.warning_date}` : "No significant drop detected"}</h2>
            {r.classes[0] && <p className="mt-2">Most likely: <b>{CAUSE_TITLES[r.classes[0].cause]}</b> <span className="muted">({Math.round(r.classes[0].probability * 100)}%, {r.confidence} confidence)</span></p>}
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">{r.evidence.map((e, i) => <li key={i}>{e.text}</li>)}</ul>
            <p className="muted mt-3 text-xs">A CSV gives account totals only. Connecting the account adds per-Pin, per-domain and Pin-age breakdowns, link checks and daily alerts.</p>
          </div>
          <div className="card"><TimelineChart dates={s.days.map((d) => d.date)} impressions={s.days.map((d) => d.impressions)} clicks={s.days.map(() => null)} markers={r.onset_date ? [{ date: r.onset_date, label: "onset", kind: "drop" }] : r.warning_date ? [{ date: r.warning_date, label: "warning", kind: "warning" }] : []} provisional={[]} /></div>
          {s.columns && <p className="muted text-xs">Columns used: {Object.entries(s.columns).map(([k, v]) => `${k} ← "${v}"`).join(", ")}{s.warnings?.length ? ` · ${s.warnings.join("; ")}` : ""}</p>}
        </div>
      )}
    </div>
  );
}

export function WeatherForm({ niches, today }: { niches: readonly string[]; today: string }) {
  const [s, act, pending] = useActionState<WeatherState, FormData>(submitWeather, null);
  return (
    <form action={act} className="space-y-3">
      <fieldset><legend className="label">How is your Pinterest reach this week?</legend>
        <label className="mr-4 text-sm"><input type="radio" name="status" value="drop" defaultChecked /> It dropped</label>
        <label className="text-sm"><input type="radio" name="status" value="normal" /> It's normal</label></fieldset>
      <div className="grid gap-3 md:grid-cols-2">
        <div><label className="label" htmlFor="niche">Niche</label><select className="input" id="niche" name="niche" required>{niches.map((n) => <option key={n}>{n}</option>)}</select></div>
        <div><label className="label" htmlFor="onset">If it dropped: first bad day</label><input className="input" id="onset" name="onset" type="date" max={today} defaultValue={today} /></div>
      </div>
      <fieldset className="text-sm"><legend className="label">What did you see? (optional)</legend>
        {[["impressions_drop", "Impressions fell"], ["new_pins_zero", "New Pins get ~0 impressions"], ["linked_pins_zero", "Linked Pins at zero, unlinked fine"], ["visit_site_missing", "Visit-site button missing"], ["ai_label", "Unexpected AI label"], ["outbound_clicks_drop", "Outbound clicks fell"]].map(([v, l]) => (
          <label key={v} className="mr-4 inline-block"><input type="checkbox" name="symptoms" value={v} /> {l}</label>
        ))}</fieldset>
      <button className="btn-primary" disabled={pending}>Submit report</button>
      {s?.ok && <p role="status" className="text-sm text-green-800">Thanks. Reports are anonymous and only counted in aggregate.</p>}
      {s?.error && <p role="alert" className="text-sm text-red-700">{s.error}</p>}
    </form>
  );
}
