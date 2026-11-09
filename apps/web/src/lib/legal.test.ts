import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/env";
import { legalFacts, placeholder } from "./legal";

const saved = { ...process.env };
afterEach(() => {
  for (const k of ["LEGAL_OPERATOR_NAME", "SUPPORT_EMAIL", "REFUND_WINDOW_DAYS", "RETENTION_RAW_DAYS"]) delete process.env[k];
  Object.assign(process.env, saved);
  resetEnvCache();
});

describe("legal page facts (SPEC-071)", () => {
  it("reads retention from the same switches the code enforces (PA-01)", () => {
    process.env.RETENTION_RAW_DAYS = "30";
    resetEnvCache();
    const f = legalFacts();
    expect(f.rawDays).toBe(30);
    expect(f.derivedDays).toBe(395);
    expect(f.scopes).toEqual(["user_accounts:read", "pins:read", "boards:read"]);
  });

  it("shows visible placeholders until the owner sets operator details and the refund window", () => {
    const f = legalFacts();
    expect(f.operator).toBe(placeholder("operator legal name"));
    expect(f.refundWindow).toBe(placeholder("refund window"));
    process.env.LEGAL_OPERATOR_NAME = "Example Ltd";
    process.env.SUPPORT_EMAIL = "support@example.com";
    process.env.REFUND_WINDOW_DAYS = "30";
    resetEnvCache();
    expect(legalFacts()).toMatchObject({ operator: "Example Ltd", supportEmail: "support@example.com", refundWindow: "30 days" });
  });
});

/** CLAUDE.md non-negotiable 5 and ASSUMPTIONS rule 3, enforced over every page and e-mail template. */
describe("copy guard", () => {
  const files: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(tsx?|html)$/.test(n) && !n.endsWith(".test.ts")) files.push(p);
    }
  };
  walk(path.join(import.meta.dirname, "..", "app"));
  walk(path.join(import.meta.dirname, "..", "modules", "notify"));
  walk(path.join(import.meta.dirname, "..", "modules", "reports"));

  it("has no recovery-guarantee language", () => {
    const bad = files.filter((f) => /guarantee/i.test(readFileSync(f, "utf8")));
    expect(bad).toEqual([]);
  });

  it("never claims Pinterest approval, partnership or endorsement except as a denial", () => {
    const claims = /(approved|endorsed|certified|partnered|sponsored) by Pinterest|Pinterest[- ](approved|partner|certified)|official Pinterest/i;
    const bad = files.flatMap((f) =>
      readFileSync(f, "utf8").split("\n").filter((l) => claims.test(l) && !/\bnot\b|\bnever\b/i.test(l)).map((l) => `${f}: ${l.trim()}`),
    );
    expect(bad).toEqual([]);
  });
});
