import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/env";
import { db } from "@/lib/db";
import type { Plan } from "./plans";

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

const PRICE_TO_PLAN: Record<string, Exclude<Plan, "trial" | "canceled">> = {
  pri_solo_monthly: "solo", pri_solo_annual: "solo", pri_pro_monthly: "pro", pri_pro_annual: "pro", pri_agency_monthly: "agency", pri_agency_annual: "agency",
};

interface PaddleEvent {
  event_id: string;
  event_type: string;
  data: { id: string; status?: string; custom_data?: { org_id?: string }; items?: { price?: { id?: string }; quantity?: number }[]; current_billing_period?: { ends_at?: string } | null };
}

/** Idempotent: each event_id is processed once. */
export async function handlePaddleEvent(rawBody: string, signature: string | null) {
  if (!verifyPaddleSignature(rawBody, signature, env().PADDLE_WEBHOOK_SECRET)) return { ok: false as const, status: 401 };
  const ev = JSON.parse(rawBody) as PaddleEvent;
  const sql = db();
  const ins = await sql`INSERT INTO billing_event (event_id, provider, type, payload) VALUES (${ev.event_id}, 'paddle', ${ev.event_type}, ${sql.json(ev as never)}) ON CONFLICT DO NOTHING`;
  if (ins.count === 0) return { ok: true as const, status: 200, duplicate: true };
  const orgId = ev.data.custom_data?.org_id;
  if (orgId && ev.event_type.startsWith("subscription.")) {
    const base = ev.data.items?.find((i) => i.price?.id && PRICE_TO_PLAN[i.price.id]);
    const extra = ev.data.items?.find((i) => i.price?.id === "pri_extra_account")?.quantity ?? 0;
    const plan: Plan = ev.event_type === "subscription.canceled" || ev.data.status === "canceled" ? "canceled" : base ? PRICE_TO_PLAN[base.price!.id!]! : "trial";
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
      id: `sub_sim_${orgId.slice(0, 8)}`, status: "active", custom_data: { org_id: orgId },
      items: [{ price: { id: `pri_${plan}_monthly` }, quantity: 1 }, ...(extraAccounts ? [{ price: { id: "pri_extra_account" }, quantity: extraAccounts }] : [])],
      current_billing_period: { ends_at: new Date(Date.now() + 30 * 86400_000).toISOString() },
    },
  });
  return handlePaddleEvent(body, signPaddle(body, env().PADDLE_WEBHOOK_SECRET));
}
