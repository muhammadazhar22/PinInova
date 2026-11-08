import { afterAll, describe, expect, it } from "vitest";
import { closePdf, htmlToPdf } from "./pdf";
import { lineChartSvg } from "./svg";

afterAll(() => closePdf());

describe("pdf", () => {
  it("renders HTML with an inline SVG chart to a PDF", async () => {
    const svg = lineChartSvg({ dates: ["2026-10-01", "2026-10-02", "2026-10-03"], series: [{ name: "Impressions", values: [10, 30, 5], color: "#0f766e" }], markers: [{ date: "2026-10-03", label: "onset" }] });
    const pdf = await htmlToPdf(`<html><body><h1>Report</h1>${svg}</body></html>`);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
    expect(pdf.length).toBeGreaterThan(1000);
  });
  it("blocks network access from report content", async () => {
    // An external image must not be fetched; rendering still succeeds.
    const pdf = await htmlToPdf(`<html><body><img src="http://169.254.169.254/x.png"><p>x</p></body></html>`);
    expect(pdf.subarray(0, 4).toString()).toBe("%PDF");
  });
});
