import type { Metadata } from "next";
import Link from "next/link";
import { PAID_PLANS, PLANS, planFeatures } from "@/modules/billing/plans";

export const metadata: Metadata = { title: "Pricing" };

// Public pricing (SPEC-080): Paddle's domain review requires prices visible without a login. Every number comes
// from PLANS, the same table billing enforces.
const INCLUDED = [
  "Daily health scan of every connected account",
  "Drops dated to the day, with the likely cause, evidence and confidence",
  "Link and domain checks against Pinterest's published guidance",
  "Pre-flight checks for Pins you are about to publish",
  "Monthly client report (PDF) and a dated evidence pack for Pinterest support",
  "Read-only Pinterest access: PinInova never edits your Pins or boards",
];

export default function Pricing() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-12">
      <p className="text-sm font-semibold text-brand-700"><Link href="/">PinInova</Link></p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Pricing</h1>
      <p className="muted mt-2 max-w-2xl">Start with a {PLANS.trial.label.match(/\d+/)?.[0] ?? "14"}-day free trial with up to {PLANS.trial.accounts} accounts, then pick a plan. Cancel any time.</p>

      <div className="mt-8 grid gap-4 md:grid-cols-3">
        {PAID_PLANS.map((p) => (
          <section key={p} className="card flex flex-col" aria-labelledby={`plan-${p}`}>
            <h2 id={`plan-${p}`} className="text-lg font-semibold">{PLANS[p].label}</h2>
            <p className="mt-2 text-3xl font-semibold tabular-nums">
              <span>${PLANS[p].priceUsd}</span><span className="muted text-sm font-normal"> per month</span>
            </p>
            <ul className="muted mt-3 flex-1 space-y-1 text-sm">
              {planFeatures(p).map((f) => <li key={f}>{f}</li>)}
            </ul>
            <Link className="btn-primary mt-4 justify-center" href="/signup">Start free trial</Link>
          </section>
        ))}
      </div>

      <section className="mt-10">
        <h2 className="text-lg font-semibold">Every plan includes</h2>
        <ul className="muted mt-2 list-disc space-y-1 pl-5 text-sm">
          {INCLUDED.map((x) => <li key={x}>{x}</li>)}
        </ul>
      </section>

      <section className="mt-8 text-sm">
        <h2 className="text-lg font-semibold">Payments</h2>
        <p className="muted mt-2">Prices are in US dollars. Paddle.com is our Merchant of Record: Paddle processes payments and adds sales tax or VAT where it applies. See the <Link className="underline" href="/refunds">refund policy</Link> and <Link className="underline" href="/terms">terms</Link>.</p>
        <p className="muted mt-2">Diagnoses are likely explanations from your own account data, not confirmations from Pinterest. PinInova cannot restore reach on Pinterest&apos;s behalf.</p>
      </section>
    </main>
  );
}
