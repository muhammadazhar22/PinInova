import { expect, test, type Page } from "@playwright/test";

const email = `va+${Date.now()}@example.com`;
const password = "correct-horse-battery";

async function waitForText(page: Page, re: RegExp, reloadEveryMs = 3000, maxMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (await page.getByText(re).first().isVisible().catch(() => false)) return;
    await page.waitForTimeout(reloadEveryMs);
    await page.reload();
  }
  throw new Error(`timed out waiting for ${re}`);
}

test("VA signs up, connects a mock account, sees the diagnosis, reports, invites a client and disconnects", async ({ page, context }) => {
  // Sign up
  await page.goto("/signup");
  await page.getByLabel("Name").fill("Test VA");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.waitForURL(/\/app/);

  // Onboarding
  await page.getByLabel("Your business or agency name").fill("Pin Studio");
  await page.getByLabel("First workspace").fill("Cliff client");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await page.waitForURL(/\/app\/w\//);
  await expect(page.getByText(/mock|simulated/i).first()).toBeVisible();

  // Connect through the mock OAuth consent page (labelled as not Pinterest)
  await page.getByRole("link", { name: "Connect Pinterest account" }).click();
  await expect(page.getByRole("heading", { name: /MOCK Pinterest/i })).toBeVisible();
  await page.locator('input[name="username"][value="mock_platform_cliff"]').check();
  await page.getByRole("button", { name: "Allow" }).click();
  await page.waitForURL(/connected=1/);
  await expect(page.getByText("Pinterest account connected")).toBeVisible();

  // The worker syncs and analyzes; the account page shows the drop.
  await page.getByRole("link", { name: /@mock_platform_cliff/ }).first().click();
  await waitForText(page, /drop detected|Distribution cut|Platform-side/i);
  await page.locator('a[href*="/incidents/"]').first().click();
  await expect(page.getByText(/Breadth|Findings|Evidence/i).first()).toBeVisible();
  await page.screenshot({ path: "test-results/incident.png", fullPage: true });
  const accountUrl = page.url().replace(/\/incidents\/.*$/, "");
  const wsUrl = accountUrl.replace(/\/a\/.*$/, "");
  await page.getByRole("button", { name: "Build evidence pack" }).click();
  await page.waitForURL(/\/reports\?created=/);
  await expect(page.getByText(/Evidence pack/i).first()).toBeVisible();

  // Monthly report from the account page, then the PDF.
  await page.goto(accountUrl);
  await page.getByRole("button", { name: "Monthly report" }).click();
  await page.waitForURL(/\/reports\?created=/);
  await expect(page.getByText(/Monthly report/i).first()).toBeVisible();
  await page.screenshot({ path: "test-results/reports.png", fullPage: true });
  const href = await page.locator('a[href*="/pdf"]').first().getAttribute("href");
  const pdf = await context.request.get(href!);
  expect(pdf.status()).toBe(200);
  expect((await pdf.body()).subarray(0, 4).toString()).toBe("%PDF");

  // Client consent link: a second browser context acts as the client.
  await page.goto(wsUrl);
  await page.getByRole("button", { name: "Create consent link" }).click();
  const linkText = await page.getByText(/\/consent\/[A-Za-z0-9_-]{20,}/).first().textContent();
  const consentUrl = linkText!.match(/https?:\/\/\S+\/consent\/[A-Za-z0-9_-]+/)![0];
  const client = await context.browser()!.newContext({ launchOptions: undefined } as never);
  const cp = await client.newPage();
  await cp.goto(consentUrl);
  await expect(cp.getByText(/read-only|PinPulse can see|What PinPulse/i).first()).toBeVisible();
  await cp.getByRole("checkbox").first().check().catch(() => undefined);
  await cp.getByRole("button", { name: /Connect|Authorize|Continue/i }).first().click();
  await cp.locator('input[name="username"][value="mock_agency_client_1"]').check();
  await cp.getByRole("button", { name: "Allow" }).click();
  await cp.waitForURL(/consent\/done/);
  await expect(cp.getByText(/revoke/i).first()).toBeVisible();
  // Client revokes from their own link
  await cp.getByRole("link", { name: /revoke/i }).first().click();
  await cp.getByRole("button", { name: /revoke|disconnect/i }).first().click();
  await cp.waitForURL(/revoke\/done/);
  await client.close();

  // Disconnect the agency's own connection; tokens destroyed and purge scheduled.
  await page.goto(accountUrl);
  await page.getByLabel("Type DELETE to confirm").fill("DELETE");
  await page.getByRole("button", { name: "Disconnect and delete" }).click();
  await page.waitForURL(/disconnected=1/);
  await expect(page.getByText(/Account disconnected/)).toBeVisible();
});
