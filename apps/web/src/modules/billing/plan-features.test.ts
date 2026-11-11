import { describe, expect, it } from "vitest";
import { PAID_PLANS, PLANS, planFeatures } from "./plans";

describe("plan features (SPEC-080: public pricing and in-app billing show the same list)", () => {
  it("lists accounts, alerts and reports for each paid plan from PLANS", () => {
    expect(PAID_PLANS).toEqual(["solo", "pro", "agency"]);
    expect(planFeatures("solo")).toEqual(["1 Pinterest account", "Email alerts", "PinInova-branded reports"]);
    expect(planFeatures("pro")).toEqual([`5 Pinterest accounts, +$${PLANS.pro.extraUsd}/month each extra`, "Email and Slack alerts", "PinInova-branded reports"]);
    expect(planFeatures("agency")[2]).toBe("White-label reports");
  });

  it("never promises recovery and never advertises a tracked-Pin limit the server caps lower", () => {
    const all = PAID_PLANS.flatMap(planFeatures).join(" ");
    expect(all).not.toMatch(/guarantee|recover/i);
    expect(all).not.toMatch(/tracked|1,?000/i);
  });
});
