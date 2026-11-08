import { Card, Chip, fmtDate } from "@/components/ui";
import { env } from "@/env";
import { requireUser } from "@/modules/auth/session";
import { entitlements, PLANS } from "@/modules/billing/plans";
import { listOrgsForUser } from "@/modules/workspaces/access";
import { simulateCheckoutAction } from "../actions";

export const metadata = { title: "Plan" };

export default async function BillingPage() {
  const user = await requireUser();
  const orgs = (await listOrgsForUser(user.id)).filter((o) => ["owner", "admin"].includes(o.role));
  const simulated = env().BILLING_MODE === "simulated";
  return (
    <div className="space-y-6">
      <h1>Plan</h1>
      {simulated && <p role="note" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">Billing is <b>simulated</b>: no payment is taken. Paddle checkout is not connected yet (see Integrations).</p>}
      {await Promise.all(orgs.map(async (o) => {
        const ent = await entitlements(o.id);
        return (
          <Card key={o.id} title={o.name} action={<Chip tone={ent.canConnect ? "good" : "warn"}>{PLANS[ent.plan as keyof typeof PLANS]?.label ?? ent.plan} · {ent.activeAccounts}/{ent.accountLimit} accounts</Chip>}>
            {ent.plan === "trial" && <p className="muted mb-3 text-sm">Trial ends {fmtDate(ent.trialEndsAt)}.</p>}
            <div className="grid gap-4 md:grid-cols-3">
              {(["solo", "pro", "agency"] as const).map((p) => (
                <form key={p} action={simulateCheckoutAction} className="rounded-lg border border-stone-200 p-4">
                  <input type="hidden" name="org" value={o.id} /><input type="hidden" name="plan" value={p} />
                  <div className="font-semibold">{PLANS[p].label}</div>
                  <div className="text-2xl font-semibold tabular-nums">${PLANS[p].priceUsd}<span className="muted text-sm">/month</span></div>
                  <ul className="muted mt-2 space-y-1 text-sm">
                    <li>{PLANS[p].accounts} account{PLANS[p].accounts > 1 ? "s" : ""}{PLANS[p].extraUsd ? `, +$${PLANS[p].extraUsd} each extra` : ""}</li>
                    <li>{PLANS[p].slack ? "Email and Slack alerts" : "Email alerts"}</li>
                    <li>{PLANS[p].whiteLabel ? "White-label reports" : "PinPulse-branded reports"}</li>
                  </ul>
                  {PLANS[p].extraUsd > 0 && <label className="mt-2 block text-xs">Extra accounts <input className="input mt-1" name="extra" type="number" min={0} max={200} defaultValue={0} /></label>}
                  <button className="btn-primary mt-3" disabled={!simulated || ent.plan === p}>{ent.plan === p ? "Current plan" : simulated ? "Switch (simulated)" : "Checkout"}</button>
                </form>
              ))}
            </div>
            <p className="muted mt-3 text-xs">Renewal reminder 7 days before any annual charge; cancel any time from this page; prorated refunds within 14 days.</p>
          </Card>
        );
      }))}
    </div>
  );
}
