import { chromium, type Browser } from "playwright-core";
import { env } from "@/env";
import { withWorkspace } from "@/lib/db";

let browser: Promise<Browser> | null = null;
function getBrowser() {
  if (!browser) {
    browser = chromium.launch({
      executablePath: env().CHROME_PATH,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
      headless: true,
    });
  }
  return browser;
}

/**
 * Render report HTML to PDF in a locked-down page: JavaScript disabled and every network request
 * blocked, so report content can never fetch anything.
 */
export async function htmlToPdf(html: string): Promise<Buffer> {
  const b = await getBrowser();
  const ctx = await b.newContext({ javaScriptEnabled: false, offline: true });
  try {
    const page = await ctx.newPage();
    await page.route("**/*", (r) => (r.request().url().startsWith("data:") ? r.continue() : r.abort()));
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({ format: "A4", printBackground: true, margin: { top: "16mm", bottom: "16mm", left: "12mm", right: "12mm" } });
  } finally {
    await ctx.close();
  }
}

export async function renderReportPdf(workspaceId: string, reportId: string) {
  const [r] = await withWorkspace(workspaceId, (tx) => tx<{ html: string }[]>`SELECT html FROM report WHERE id = ${reportId}`);
  if (!r) throw new Error("report not found");
  const pdf = await htmlToPdf(r.html);
  await withWorkspace(workspaceId, (tx) => tx`UPDATE report SET pdf = ${pdf} WHERE id = ${reportId}`);
  return pdf;
}

export async function closePdf() {
  if (browser) {
    await (await browser).close();
    browser = null;
  }
}
