import Link from "next/link";
import { Card, Chip, fmtDate } from "@/components/ui";
import { PaddleCheckoutButton } from "@/components/PaddleCheckout";
import { env } from "@/env";
import { appUrl } from "@/lib/urls";
import { requireUser } from "@/modules/auth/session";
import { checkoutConfig, extraPriceId, type CheckoutConfig } from "@/modules/billing/paddle";
import { entitlements, PAID_PLANS, PLANS, planFeatures, type PaidPlan } from "@/modules/billing/plans";
import { listOrgsForUser } from "@/modules/workspaces/access";
import { simulateCheckoutAction } from "../actions";

export const metadata = { title: "Plan" };

function tryCheckout(orgId: string, plan: PaidPlan, email: string): CheckoutConfig | null {
  try {
    return checkoutConfig(orgId, plan, 0, email);
  } catch {
    return null; // not configured (development); the button stays disabled with a note
  }
}

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ checkout?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const orgs = (await listOrgsForUser(user.id)).filter((o) => ["owner", "admin"].includes(o.role));
  const mode = env().BILLING_MODE;
  const simulated = mode === "simulated";
  return (
    <div className="space-y-6">
      <h1>Plan</h1>
      {simulated && <p role="note" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Billing is <b>simulated</b>: no payment is taken. Paddle checkout is not connected yet (see Integrations).</p>}
      {mode === "paddle_sandbox" && <p role="note" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Paddle <b>sandbox</b>: test cards only, no real payment is taken.</p>}
      {sp.checkout === "done" && <p role="status" className="rounded-lg bg-stone-100 p-3 text-sm">Thanks, your payment went through. Your plan updates here within a minute, once Paddle confirms it.</p>}
      {await Promise.all(orgs.map(async (o) => {
        const ent = await entitlements(o.id);
        const paying = ent.provider === "paddle" && ent.plan !== "canceled" && ent.plan !== "trial";
        return (
          <Card key={o.id} title={o.name} action={<Chip tone={ent.canConnect ? "good" : "warn"}>{PLANS[ent.plan as keyof typeof PLANS]?.label ?? ent.plan} · {ent.activeAccounts}/{ent.accountLimit} accounts</Chip>}>
            {ent.plan === "trial" && <p className="muted mb-3 text-sm">Trial ends {fmtDate(ent.trialEndsAt)}.</p>}
            {!simulated && paying && <p className="mb-3 text-sm">To change or cancel this plan, use the link in your Paddle receipt e-mail, or e-mail support and we will change it for you.</p>}
            <div className="grid gap-4 md:grid-cols-3">
              {PAID_PLANS.map((p) => {
                const cfg = simulated || paying ? null : tryCheckout(o.id, p, user.email);
                return (
                  <form key={p} action={simulated ? simulateCheckoutAction : undefined} className="rounded-lg border border-stone-200 p-4">
                    <input type="hidden" name="org" value={o.id} /><input type="hidden" name="plan" value={p} />
                    <div className="font-semibold">{PLANS[p].label}</div>
                    <div className="text-2xl font-semibold tabular-nums">${PLANS[p].priceUsd}<span className="muted text-sm">/month</span></div>
                    <ul className="muted mt-2 space-y-1 text-sm">
                      {planFeatures(p).map((f) => <li key={f}>{f}</li>)}
                    </ul>
                    {PLANS[p].extraUsd > 0 && !paying && <label className="mt-2 block text-xs">Extra accounts <input className="input mt-1" name="extra" type="number" min={0} max={200} defaultValue={0} /></label>}
                    {simulated ? (
                      <button className="btn-primary mt-3" disabled={ent.plan === p}>{ent.plan === p ? "Current plan" : "Switch (simulated)"}</button>
                    ) : ent.plan === p ? (
                      <button className="btn-primary mt-3" disabled>Current plan</button>
                    ) : cfg ? (
                      <PaddleCheckoutButton config={cfg} extraPriceId={extraPriceId(p)} successUrl={appUrl("/app/billing?checkout=done").toString()} />
                    ) : (
                      <button className="btn-primary mt-3" disabled title="Paddle is not configured on this server">Checkout</button>
                    )}
                  </form>
                );
              })}
            </div>
            <p className="muted mt-3 text-xs">Payments are processed by Paddle.com, our Merchant of Record. Cancel any time through the link in your Paddle receipt. See the <Link className="underline" href="/refunds">refund policy</Link>.</p>
          </Card>
        );
      }))}
    </div>
  );
}
