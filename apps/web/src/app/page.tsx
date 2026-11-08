import Link from "next/link";
import { env } from "@/env";
import { MockBanner } from "@/components/ui";

export default async function Home({ searchParams }: { searchParams: Promise<{ deleted?: string }> }) {
  const sp = await searchParams;
  return (
    <div>
      <MockBanner mode={env().PINTEREST_MODE} />
      <main className="mx-auto max-w-4xl px-4 py-16">
        {sp.deleted && <p role="status" className="mb-6 rounded-lg bg-stone-100 p-3 text-sm">Your account and its data were deleted.</p>}
        <p className="text-sm font-semibold text-brand-700">PinPulse</p>
        <h1 className="mt-2 text-4xl font-semibold tracking-tight">Know what happened to your Pinterest reach, and what to do next.</h1>
        <p className="muted mt-4 max-w-2xl text-lg">PinPulse watches every account daily, dates the moment reach changed, separates platform-side drops from fixable problems, and builds the evidence pack and client report for you. Read-only access. Built for Pinterest VAs, agencies and creators.</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link className="btn-primary" href="/signup">Start free trial</Link>
          <Link className="btn-secondary" href="/drop-check">Free Drop Check (no account)</Link>
          <Link className="btn-secondary" href="/weather">Is it just me? Weather</Link>
          <Link className="btn-secondary" href="/login">Sign in</Link>
        </div>
        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {[
            ["Diagnose", "Five likely causes, each with evidence and confidence: platform-side change, link or domain restriction, publishing pattern, quality down-ranking, or normal decay."],
            ["Protect", "Daily link and domain checks against Pinterest's published guidance, pre-flight checks for scheduled Pins, and early warnings before clients notice."],
            ["Report", "A monthly report your client can read, and a dated evidence pack for Pinterest support. No recovery promises; just facts."],
          ].map(([t, d]) => <div key={t} className="card"><h2>{t}</h2><p className="muted mt-2 text-sm">{d}</p></div>)}
        </div>
        <p className="muted mt-12 text-xs">PinPulse is not affiliated with, endorsed by, or approved by Pinterest. Diagnoses are likely explanations from your own account data, not confirmations from Pinterest.</p>
      </main>
    </div>
  );
}
