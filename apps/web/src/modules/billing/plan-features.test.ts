import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/env";
import { PAID_PLANS, PLANS, planFeatures } from "./plans";

afterEach(() => {
  delete process.env.TRACKED_PINS_CAP;
  resetEnvCache();
});

describe("plan features (SPEC-080: public pricing and in-app billing show the same list)", () => {
  it("lists accounts, tracked Pins, alerts and reports for each paid plan from PLANS", () => {
    expect(PAID_PLANS).toEqual(["solo", "pro", "agency"]);
    expect(planFeatures("solo")).toEqual(["1 Pinterest account", "Up to 300 Pins tracked individually", "Email alerts", "PinInova-branded reports"]);
    expect(planFeatures("pro")).toEqual([
      `5 Pinterest accounts, +$${PLANS.pro.extraUsd}/month each extra`,
      "Up to 1,000 Pins tracked individually per account",
      "Email and Slack alerts",
      "PinInova-branded reports",
    ]);
    expect(planFeatures("agency")[3]).toBe("White-label reports");
  });

  it("never promises recovery", () => {
    expect(PAID_PLANS.flatMap(planFeatures).join(" ")).not.toMatch(/guarantee|recover/i);
  });

  it("advertises the tracked-Pin limit actually delivered: the plan's, or the server cap if lower", () => {
    process.env.TRACKED_PINS_CAP = "500";
    resetEnvCache();
    expect(planFeatures("agency")[1]).toBe("Up to 500 Pins tracked individually per account");
    expect(planFeatures("solo")[1]).toBe("Up to 300 Pins tracked individually");
  });
});
