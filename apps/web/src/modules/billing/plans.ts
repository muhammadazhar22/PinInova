import { env } from "@/env";
import { db, type Tx, one } from "@/lib/db";

export type Plan = "trial" | "solo" | "pro" | "agency" | "canceled";

export const PLANS: Record<Exclude<Plan, "canceled">, { label: string; priceUsd: number; accounts: number; extraUsd: number; whiteLabel: boolean; slack: boolean; trackedPins: number }> = {
  trial: { label: "Trial (14 days)", priceUsd: 0, accounts: 5, extraUsd: 0, whiteLabel: false, slack: true, trackedPins: 300 },
  solo: { label: "Solo", priceUsd: 19, accounts: 1, extraUsd: 0, whiteLabel: false, slack: false, trackedPins: 300 },
  pro: { label: "Pro (VA)", priceUsd: 39, accounts: 5, extraUsd: 6, whiteLabel: false, slack: true, trackedPins: 1000 },
  agency: { label: "Agency", priceUsd: 99, accounts: 20, extraUsd: 5, whiteLabel: true, slack: true, trackedPins: 1000 },
};

export const PAID_PLANS = ["solo", "pro", "agency"] as const;
export type PaidPlan = (typeof PAID_PLANS)[number];

/** Pins tracked individually per account: the plan's number, bounded by the server-wide TRACKED_PINS_CAP (sync.ts). */
export function deliveredTrackedPins(p: Exclude<Plan, "canceled">): number {
  return Math.min(PLANS[p].trackedPins, env().TRACKED_PINS_CAP);
}

/**
 * What each paid plan includes, for the public /pricing page and in-app billing (one list, so they cannot drift).
 * The tracked-Pin line shows what sync actually delivers (`deliveredTrackedPins`), so it can never overstate it.
 */
export function planFeatures(p: PaidPlan): string[] {
  const x = PLANS[p];
  return [
    `${x.accounts} Pinterest account${x.accounts > 1 ? "s" : ""}${x.extraUsd ? `, +$${x.extraUsd}/month each extra` : ""}`,
    `Up to ${deliveredTrackedPins(p).toLocaleString("en-US")} Pins tracked individually${x.accounts > 1 ? " per account" : ""}`,
    x.slack ? "Email and Slack alerts" : "Email alerts",
    x.whiteLabel ? "White-label reports" : "PinInova-branded reports",
  ];
}

export interface Entitlements {
  plan: Plan;
  status: string;
  accountLimit: number;
  activeAccounts: number;
  canConnect: boolean;
  whiteLabel: boolean;
  slack: boolean;
  trackedPins: number;
  trialEndsAt: Date | null;
  /** "paddle" once a Paddle subscription exists for the org (plan changes then go through Paddle); null otherwise. */
  provider: string | null;
}

export async function ensureSubscription(orgId: string) {
  await db()`INSERT INTO subscription (org_id, plan, status, trial_ends_at) VALUES (${orgId}, 'trial', 'trialing', now() + interval '14 days')
             ON CONFLICT (org_id) DO NOTHING`;
}

export async function entitlements(orgId: string, tx?: Tx): Promise<Entitlements> {
  const sql = tx ?? db();
  await ensureSubscription(orgId);
  const [s] = await sql<{ plan: Plan; status: string; extra_accounts: number; trial_ends_at: Date | null; provider: string | null }[]>`
    SELECT plan, status, extra_accounts, trial_ends_at, provider FROM subscription WHERE org_id = ${orgId}`;
  const { n } = await one(sql<{ n: number }[]>`SELECT system_org_active_accounts(${orgId}) AS n`);
  const plan = s!.plan;
  const trialExpired = plan === "trial" && s!.trial_ends_at !== null && s!.trial_ends_at < new Date();
  if (plan === "canceled" || trialExpired) {
    return { plan, status: trialExpired ? "trial_expired" : s!.status, accountLimit: 0, activeAccounts: n, canConnect: false, whiteLabel: false, slack: false, trackedPins: 50, trialEndsAt: s!.trial_ends_at, provider: s!.provider ?? null };
  }
  const p = PLANS[plan];
  const limit = p.accounts + (s!.extra_accounts ?? 0);
  return { plan, status: s!.status, accountLimit: limit, activeAccounts: n, canConnect: n < limit, whiteLabel: p.whiteLabel, slack: p.slack, trackedPins: p.trackedPins, trialEndsAt: s!.trial_ends_at, provider: s!.provider ?? null };
}
