import { env } from "@/env";
import { consentText } from "@/modules/pinterest/consent";
import { lookupConsentRequest } from "@/modules/pinterest/connections";

export const metadata = { title: "Connect your Pinterest account" };

export default async function ConsentPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<{ e?: string }> }) {
  const { token } = await params;
  const { e } = await searchParams;
  const r = await lookupConsentRequest(token);
  if (!r || r.used_at || r.expires_at < new Date()) {
    return <main className="mx-auto mt-20 max-w-lg px-4"><h1>This link is no longer valid</h1><p className="muted mt-2">It was already used or has expired. Ask whoever sent it for a new one.</p></main>;
  }
  const ev = env();
  const t = consentText({ orgName: r.org_name, workspaceName: r.workspace_name, rawDays: ev.RETENTION_RAW_DAYS, derivedDays: ev.RETENTION_DERIVED_DAYS, scopes: ev.PINTEREST_SCOPES.split(",") });
  return (
    <main className="mx-auto mt-12 max-w-xl px-4 pb-16">
      <p className="text-sm font-semibold text-brand-700">PinPulse</p>
      <h1 className="mt-2">{t.title}</h1>
      <ul className="mt-4 list-disc space-y-2 pl-5">{t.points.map((p) => <li key={p}>{p}</li>)}</ul>
      {ev.PINTEREST_MODE === "mock" && <p className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">This environment uses a <b>mock</b> Pinterest login, not the real Pinterest.</p>}
      <form method="post" action={`/api/consent/${token}/start`} className="mt-6 space-y-3">
        <label className="flex gap-2 text-sm"><input type="checkbox" name="agree" value="yes" required /> I own or manage this Pinterest account and agree to the above.</label>
        {e === "agree" && <p role="alert" className="text-sm text-red-700">Please confirm before continuing.</p>}
        <button className="btn-primary">Continue to Pinterest</button>
      </form>
      <p className="muted mt-6 text-xs">Consent text version {t.version}. You will authorize on Pinterest's own page; PinPulse never sees your password.</p>
    </main>
  );
}
