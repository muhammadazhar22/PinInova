import { describe, expect, it } from "vitest";
import { median, newPinsFinding } from "./new-pins";

const repeat = (n: number, v: (i: number) => number) => Array.from({ length: n }, (_, i) => v(i));

describe("new-Pin distribution rule (SPEC-079)", () => {
  it("flags new Pins at a few views while older Pins perform (mock_new_pins_zero: ~1.2 vs ~22.6)", () => {
    const f = newPinsFinding(repeat(30, (i) => (i % 3) * 0.8), repeat(87, (i) => 8 + (i % 30)));
    expect(f).not.toBeNull();
    expect(f!.newCount).toBe(30);
    expect(f!.olderCount).toBe(87);
    expect(f!.ratio).toBeLessThan(0.1);
  });

  it("does not flag new Pins performing like older ones", () => {
    expect(newPinsFinding(repeat(12, (i) => 20 + i), repeat(80, (i) => 10 + (i % 20)))).toBeNull();
  });

  it("needs enough new and older Pins", () => {
    expect(newPinsFinding(repeat(7, () => 0), repeat(80, () => 30))).toBeNull();
    expect(newPinsFinding(repeat(20, () => 0), repeat(19, () => 30))).toBeNull();
  });

  it("does not flag a low-traffic account (older median under 5 views a day)", () => {
    expect(newPinsFinding(repeat(20, () => 0), repeat(80, () => 4))).toBeNull();
  });

  it("is at the 20% boundary inclusive", () => {
    expect(newPinsFinding(repeat(10, () => 2), repeat(30, () => 10))).not.toBeNull();
    expect(newPinsFinding(repeat(10, () => 2.1), repeat(30, () => 10))).toBeNull();
  });

  it("median of even and odd lists", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
