import { describe, expect, it } from "vitest";
import { benjaminiHochberg, causeThreshold, qValues } from "./stats";

describe("Benjamini–Hochberg", () => {
  it("matches the textbook example", () => {
    const p = [0.01, 0.04, 0.03, 0.005, 0.2];
    expect(benjaminiHochberg(p, 0.05)).toEqual([true, true, true, true, false]);
    expect(benjaminiHochberg([0.02, 0.5, 0.9], 0.05)).toEqual([false, false, false]);
    expect(benjaminiHochberg([0.02], 0.05)).toEqual([true]);
  });
  it("q-values are monotone and ≥ p", () => {
    const p = [0.001, 0.02, 0.03, 0.5];
    const q = qValues(p);
    q.forEach((v, i) => expect(v).toBeGreaterThanOrEqual(p[i]!));
    expect(q[0]).toBeCloseTo(0.004);
  });
  it("sensitivity lowers the cause threshold", () => {
    expect(causeThreshold(0.5)).toBeCloseTo(0.5);
    expect(causeThreshold(0.9)).toBeLessThan(causeThreshold(0.1));
  });
});
