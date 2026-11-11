import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/env";
import { db } from "@/lib/db";
import { PAID_PLANS, PLANS, type PaidPlan, type Plan } from "./plans";

/**
 * Paddle Billing webhooks. NOT production-ready (docs/INTEGRATIONS.md): verified against signed
 * fixtures only. Signature header: "ts=<unix>;h1=<hex HMAC-SHA256 of `${ts}:${rawBody}`>".
 */
export function verifyPaddleSignature(rawBody: string, header: string | null, secret: string, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(";").map((p) => p.split("=") as [string, string]));
  const ts = Number(parts.ts);
  if (!parts.ts || !parts.h1 || !Number.isFinite(ts) || Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = createHmac("sha256", secret).update(`${parts.ts}:${rawBody}`).digest();
  const got = Buffer.from(parts.h1, "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export function signPaddle(rawBody: string, secret: string, ts = Math.floor(Date.now() / 1000)) {
  return `ts=${ts};h1=${createHmac("sha256", secret).update(`${ts}:${rawBody}`).digest("hex")}`;
}

/** Simulated mode has no Paddle catalogue; these stand in for real price IDs there only. */
const SIMULATED_PRICES = { solo: "pri_solo_monthly", pro: "pri_pro_monthly", agency: "pri_agency_monthly", extra_pro: "pri_extra_account", extra_agency: "pri_extra_account" } as const;

/** Catalogue price IDs: from settings with Paddle (SPEC-081), fixed stand-ins when simulated. */
export function priceIds(): { solo?: string; pro?: string; agency?: string; extra_pro?: string; extra_agency?: string } {
  const e = env();
  if (e.BILLING_MODE === "simulated") return SIMULATED_PRICES;
  return { solo: e.PADDLE_PRICE_SOLO, pro: e.PADDLE_PRICE_PRO, agency: e.PADDLE_PRICE_AGENCY, extra_pro: e.PADDLE_PRICE_EXTRA_PRO, extra_agency: e.PADDLE_PRICE_EXTRA_AGENCY };
}

/** Extra-account add-on price for a plan (Pro and Agency charge different amounts, so each has its own price). */
export function extraPriceId(plan: PaidPlan): string | undefined {
  const p = priceIds();
  return plan === "pro" ? p.extra_pro : plan === "agency" ? p.extra_agency : undefined;
}

function planForPrice(id: string | undefined): PaidPlan | null {
  if (!id) return null;
  const p = priceIds();
  return (PAID_PLANS as readonly PaidPlan[]).find((k) => p[k] === id) ?? null;
}

/**
 * Checkout custom_data is set in the buyer's browser, so an org id there proves nothing: anyone could open a checkout
 * for another org and later cancel it. The server signs the org id when it builds the checkout and the webhook applies
 * subscription events only with a valid signature (SPEC-081). Keyed by the server-only auth secret.
 */
export function orgSignature(orgId: string): string {
  return createHmac("sha256", env().BETTER_AUTH_SECRET).update(`paddle-checkout:v1:${orgId}`).digest("hex");
}

function validOrgSignature(orgId: string, sig: unknown): boolean {
  if (typeof sig !== "string" || !/^[0-9a-f]{64}$/.test(sig)) return false;
  return timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(orgSignature(orgId), "hex"));
}

export interface CheckoutConfig {
  environment: "sandbox" | "production";
  token: string;
  items: { priceId: string; quantity: number }[];
  customData: { org_id: string; org_sig: string };
  customer: { email: string };
}

/** Everything Paddle.js needs to open the overlay checkout for one org and plan. */
export function checkoutConfig(orgId: string, plan: PaidPlan, extraAccounts: number, email: string): CheckoutConfig {
  const e = env();
  if (e.BILLING_MODE === "simulated") throw new Error("Paddle checkout is not configured: BILLING_MODE is simulated");
  const p = priceIds();
  const need: [string, string | undefined][] = [["PADDLE_CLIENT_TOKEN", e.PADDLE_CLIENT_TOKEN], [`PADDLE_PRICE_${plan.toUpperCase()}`, p[plan]]];
  if (extraAccounts > 0 && PLANS[plan].extraUsd > 0) need.push([`PADDLE_PRICE_EXTRA_${plan.toUpperCase()}`, extraPriceId(plan)]);
  const missing = need.filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) throw new Error(`Paddle checkout is not configured: set ${missing.join(", ")}`);
  const extra = Math.max(0, Math.min(200, Math.floor(extraAccounts)));
  return {
    environment: e.BILLING_MODE === "paddle_live" ? "production" : "sandbox",
    token: e.PADDLE_CLIENT_TOKEN!,
    items: [{ priceId: p[plan]!, quantity: 1 }, ...(extra > 0 && PLANS[plan].extraUsd > 0 ? [{ priceId: extraPriceId(plan)!, quantity: extra }] : [])],
    customData: { org_id: orgId, org_sig: orgSignature(orgId) },
    customer: { email },
  };
}

interface PaddleEvent {
  event_id: string;
  event_type: string;
  data: { id: string; status?: string; custom_data?: { org_id?: string; org_sig?: string }; items?: { price?: { id?: string }; quantity?: number }[]; current_billing_period?: { ends_at?: string } | null };
}

/** Idempotent: each event_id is processed once. */
export async function handlePaddleEvent(rawBody: string, signature: string | null) {
  if (!verifyPaddleSignature(rawBody, signature, env().PADDLE_WEBHOOK_SECRET)) return { ok: false as const, status: 401 };
  const ev = JSON.parse(rawBody) as PaddleEvent;
  const sql = db();
  const ins = await sql`INSERT INTO billing_event (event_id, provider, type, payload) VALUES (${ev.event_id}, 'paddle', ${ev.event_type}, ${sql.json(ev as never)}) ON CONFLICT DO NOTHING`;
  if (ins.count === 0) return { ok: true as const, status: 200, duplicate: true };
  const orgId = ev.data.custom_data?.org_id;
  if (orgId && ev.event_type.startsWith("subscription.") && !validOrgSignature(orgId, ev.data.custom_data?.org_sig)) {
    // Recorded above for audit; acknowledged so Paddle does not retry, but it changes no subscription (SPEC-081).
    await sql`UPDATE billing_event SET processed_at = now() WHERE event_id = ${ev.event_id}`;
    return { ok: true as const, status: 200, ignored: "org_signature" as const };
  }
  if (orgId && ev.event_type.startsWith("subscription.")) {
    const base = ev.data.items?.map((i) => planForPrice(i.price?.id)).find((x): x is PaidPlan => x !== null);
    const extraIds = new Set([priceIds().extra_pro, priceIds().extra_agency].filter(Boolean));
    const extra = ev.data.items?.find((i) => i.price?.id && extraIds.has(i.price.id))?.quantity ?? 0;
    const plan: Plan = ev.event_type === "subscription.canceled" || ev.data.status === "canceled" ? "canceled" : base ?? "trial";
    await sql`
      INSERT INTO subscription (org_id, plan, status, provider, provider_ref, current_period_end, extra_accounts, updated_at)
      VALUES (${orgId}, ${plan}, ${ev.data.status ?? "active"}, 'paddle', ${ev.data.id}, ${ev.data.current_billing_period?.ends_at ?? null}, ${extra}, now())
      ON CONFLICT (org_id) DO UPDATE SET plan = EXCLUDED.plan, status = EXCLUDED.status, provider = 'paddle', provider_ref = EXCLUDED.provider_ref,
        current_period_end = EXCLUDED.current_period_end, extra_accounts = EXCLUDED.extra_accounts, updated_at = now()`;
  }
  await sql`UPDATE billing_event SET processed_at = now() WHERE event_id = ${ev.event_id}`;
  return { ok: true as const, status: 200 };
}

/** Simulated checkout (BILLING_MODE=simulated): builds a signed event and runs it through the real handler. */
export async function simulateCheckout(orgId: string, plan: "solo" | "pro" | "agency", extraAccounts = 0) {
  if (env().BILLING_MODE !== "simulated") throw new Error("simulated checkout is disabled");
  const body = JSON.stringify({
    event_id: `evt_sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    event_type: "subscription.updated",
    data: {
      id: `sub_sim_${orgId.slice(0, 8)}`, status: "active", custom_data: { org_id: orgId, org_sig: orgSignature(orgId) },
      items: [{ price: { id: SIMULATED_PRICES[plan] }, quantity: 1 }, ...(extraAccounts ? [{ price: { id: "pri_extra_account" }, quantity: extraAccounts }] : [])],
      current_billing_period: { ends_at: new Date(Date.now() + 30 * 86400_000).toISOString() },
    },
  });
  return handlePaddleEvent(body, signPaddle(body, env().PADDLE_WEBHOOK_SECRET));
}
