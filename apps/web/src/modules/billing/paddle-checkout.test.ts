import { afterAll, afterEach, describe, expect, it } from "vitest";
import { closeDb } from "@/lib/db";
import { resetEnvCache } from "@/env";
import { entitlements } from "./plans";
import { checkoutConfig, handlePaddleEvent, orgSignature, signPaddle } from "./paddle";
import { makeOrgUser, owner } from "../../../test/factory";

const own = owner();
const saved = { ...process.env };
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  resetEnvCache();
});
afterAll(async () => { await own.end(); await closeDb(); });

function paddleSandbox() {
  Object.assign(process.env, {
    BILLING_MODE: "paddle_sandbox",
    PADDLE_WEBHOOK_SECRET: "pdl_ntfset_test_secret",
    PADDLE_CLIENT_TOKEN: "test_abc123",
    PADDLE_PRICE_SOLO: "pri_01solo", PADDLE_PRICE_PRO: "pri_01pro", PADDLE_PRICE_AGENCY: "pri_01agency", PADDLE_PRICE_EXTRA_PRO: "pri_01extrapro", PADDLE_PRICE_EXTRA_AGENCY: "pri_01extraagency",
  });
  resetEnvCache();
}

function event(orgId: string, customData: Record<string, unknown>, priceId = "pri_01pro", type = "subscription.created") {
  const body = JSON.stringify({
    event_id: `evt_${Math.random().toString(36).slice(2)}`, event_type: type,
    data: { id: `sub_${orgId.slice(0, 6)}`, status: type === "subscription.canceled" ? "canceled" : "active", custom_data: customData,
      items: [{ price: { id: priceId }, quantity: 1 }], current_billing_period: { ends_at: "2026-12-11T00:00:00Z" } },
  });
  return handlePaddleEvent(body, signPaddle(body, process.env.PADDLE_WEBHOOK_SECRET!));
}

describe("Paddle checkout (SPEC-081)", () => {
  it("builds a sandbox checkout with the configured price IDs and a signed org id", () => {
    paddleSandbox();
    const c = checkoutConfig("org-1", "pro", 2, "va@example.com");
    expect(c).toEqual({
      environment: "sandbox", token: "test_abc123",
      items: [{ priceId: "pri_01pro", quantity: 1 }, { priceId: "pri_01extrapro", quantity: 2 }],
      customData: { org_id: "org-1", org_sig: orgSignature("org-1") },
      customer: { email: "va@example.com" },
    });
    expect(orgSignature("org-1")).not.toBe(orgSignature("org-2"));
    // Agency extras use their own price ($5 vs Pro's $6); Solo has no extras.
    expect(checkoutConfig("org-1", "agency", 1, "a@b.c").items[1]).toEqual({ priceId: "pri_01extraagency", quantity: 1 });
    expect(checkoutConfig("org-1", "solo", 3, "a@b.c").items).toHaveLength(1);
  });

  it("refuses checkout in simulated mode or without price IDs", () => {
    expect(() => checkoutConfig("org-1", "solo", 0, "a@b.c")).toThrow(/simulated|not configured/i);
    paddleSandbox();
    delete process.env.PADDLE_PRICE_AGENCY;
    resetEnvCache();
    expect(() => checkoutConfig("org-1", "agency", 0, "a@b.c")).toThrow(/PADDLE_PRICE_AGENCY/);
  });

  it("applies a subscription only when custom_data carries a valid org signature", async () => {
    paddleSandbox();
    const victim = await makeOrgUser(own);
    // Tampered checkout: someone else's org id with no or a wrong signature changes nothing.
    expect((await event(victim.orgId, { org_id: victim.orgId })).status).toBe(200);
    expect((await entitlements(victim.orgId)).plan).toBe("trial");
    await event(victim.orgId, { org_id: victim.orgId, org_sig: orgSignature("someone-else") }, "pri_01pro", "subscription.canceled");
    expect((await entitlements(victim.orgId)).plan).toBe("trial");

    await event(victim.orgId, { org_id: victim.orgId, org_sig: orgSignature(victim.orgId) });
    expect(await entitlements(victim.orgId)).toMatchObject({ plan: "pro", accountLimit: 5, provider: "paddle" });
  });

  it("maps real price IDs from settings, not the simulated ones", async () => {
    paddleSandbox();
    const { orgId } = await makeOrgUser(own);
    await event(orgId, { org_id: orgId, org_sig: orgSignature(orgId) }, "pri_pro_monthly");
    expect((await entitlements(orgId)).plan).toBe("trial"); // unknown price: no paid plan
    await event(orgId, { org_id: orgId, org_sig: orgSignature(orgId) }, "pri_01agency");
    expect((await entitlements(orgId)).plan).toBe("agency");
  });
});
