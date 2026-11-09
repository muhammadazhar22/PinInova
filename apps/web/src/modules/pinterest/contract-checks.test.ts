import { describe, expect, it } from "vitest";
import { checkAnalyticsSplits, checkProvisional, checkTimestamps, checkWebsites, summarize } from "./contract-checks";

const day = (date: string, status = "READY") => ({ date, data_status: status, metrics: { IMPRESSION: 1, OUTBOUND_CLICK: 1, PIN_CLICK: 1, SAVE: 1 } });

describe("live contract checks (SPEC-076, docs/INTEGRATIONS.md 'Contract details the mock had to guess')", () => {
  it("1. split keys: mock reading passes; several NO_SPLIT keys fail (rows would collide)", () => {
    expect(checkAnalyticsSplits({ all: { daily_metrics: [day("2026-11-01")] } }, { CLAIMED: { daily_metrics: [] }, OTHER: { daily_metrics: [] } }).status).toBe("pass");
    expect(checkAnalyticsSplits({ ALL: { daily_metrics: [day("2026-11-01")] } }, {}).status).toBe("pass");
    expect(checkAnalyticsSplits({ a: { daily_metrics: [day("2026-11-01")] }, b: { daily_metrics: [] } }, {}).status).toBe("fail");
    const noMetric = checkAnalyticsSplits({ all: { daily_metrics: [{ date: "2026-11-01", metrics: { IMPRESSIONS: 1 } }] } }, {});
    expect(noMetric.status).toBe("fail");
    expect(noMetric.detail).toMatch(/IMPRESSION/);
    expect(checkAnalyticsSplits({ all: { daily_metrics: [{ date: "11/01/2026", metrics: day("x").metrics }] } }, {}).status).toBe("fail");
  });

  it("2. timestamps: Z and offsets pass; naive timestamps warn (stored as UTC); garbage fails", () => {
    expect(checkTimestamps(["2026-11-01T10:00:00Z", "2026-11-02T10:00:00+05:00"]).status).toBe("pass");
    expect(checkTimestamps(["2026-11-01T10:00:00"]).status).toBe("warn");
    expect(checkTimestamps(["yesterday"]).status).toBe("fail");
    expect(checkTimestamps([]).status).toBe("skip");
  });

  it("3. websites: scheme or bare host both give a domain; unknown statuses warn", () => {
    expect(checkWebsites([{ website: "https://example.com", status: "verified" }, { website: "shop.example", status: "unverified" }]).status).toBe("pass");
    const odd = checkWebsites([{ website: "example.com", status: "SOMETHING_NEW" }]);
    expect(odd.status).toBe("warn");
    expect(odd.detail).toMatch(/SOMETHING_NEW/);
    expect(checkWebsites([{ website: "::::" }]).status).toBe("fail");
    expect(checkWebsites([]).status).toBe("skip");
  });

  it("PA-08: reports which of the most recent days are still provisional", () => {
    const r = checkProvisional({ all: { daily_metrics: [day("2026-11-05"), day("2026-11-06", "PROCESSING"), day("2026-11-07", "PROCESSING")] } });
    expect(r.status).toBe("pass");
    expect(r.detail).toMatch(/2 day/);
  });

  it("summary fails if any check failed", () => {
    expect(summarize([{ id: "a", status: "pass", detail: "" }, { id: "b", status: "warn", detail: "" }]).ok).toBe(true);
    expect(summarize([{ id: "a", status: "fail", detail: "" }]).ok).toBe(false);
  });
});
