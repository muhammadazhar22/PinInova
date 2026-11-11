import { chromium, type Browser } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "@/env";
import { REPORT_CSS } from "./build";

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch({ executablePath: env().CHROME_PATH, args: ["--no-sandbox"], headless: true });
});
afterAll(() => browser?.close());

describe("report layout", () => {
  it("top-aligns the KPI row when a KPI has no sub-line (health score with one snapshot)", async () => {
    const page = await browser.newPage();
    await page.setContent(`<style>${REPORT_CSS}</style><div>
      <span class="k">Impressions<b>79,696</b><span class="muted">-72% vs prior 30 days</span></span>
      <span class="k">Saves<b>1,484</b><span class="muted">-73%</span></span>
      <span class="k">Health score<b>25</b><span class="muted"></span></span></div>`);
    const tops = await page.locator(".k").evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
    expect(new Set(tops).size).toBe(1);
  });
});
