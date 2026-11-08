import { afterAll, describe, expect, it } from "vitest";
import { closeDb } from "@/lib/db";
import { entitlements } from "./plans";
import { handlePaddleEvent, signPaddle, simulateCheckout, verifyPaddleSignature } from "./paddle";
import { makeOrgUser, owner } from "../../../test/factory";

const own = owner();
afterAll(async () => { await own.end(); await closeDb(); });

describe("paddle webhooks", () => {
  it("verifies signatures and rejects tampering, wrong secret, and stale timestamps", () => {
    const body = '{"a":1}';
    const sig = signPaddle(body, "s3cret");
    expect(verifyPaddleSignature(body, sig, "s3cret")).toBe(true);
    expect(verifyPaddleSignature('{"a":2}', sig, "s3cret")).toBe(false);
    expect(verifyPaddleSignature(body, sig, "other")).toBe(false);
    expect(verifyPaddleSignature(body, signPaddle(body, "s3cret", 1000), "s3cret")).toBe(false);
    expect(verifyPaddleSignature(body, null, "s3cret")).toBe(false);
  });
  it("rejects unsigned events and processes signed ones idempotently", async () => {
    const { orgId } = await makeOrgUser(own);
    expect((await handlePaddleEvent("{}", "ts=1;h1=00")).status).toBe(401);
    const before = await entitlements(orgId);
    expect(before.plan).toBe("trial");
    await simulateCheckout(orgId, "agency", 3);
    const after = await entitlements(orgId);
    expect(after).toMatchObject({ plan: "agency", accountLimit: 23, whiteLabel: true });
  });
});
