import { expect, test } from "@playwright/test";

// SPEC-071: public legal pages exist without a login and are linked from every page's footer.
test("privacy, terms and refund pages are public and linked from the footer", async ({ page }) => {
  await page.goto("/");
  const footer = page.getByRole("navigation", { name: "Legal" });
  for (const [name, heading] of [["Privacy", "Privacy policy"], ["Terms", "Terms of service"], ["Refunds", "Refund policy"]] as const) {
    await footer.getByRole("link", { name }).click();
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    await expect(page.getByText(/not affiliated with, endorsed by, or approved by Pinterest/).first()).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/guarantee/i);
    await page.goto("/");
  }
  await page.goto("/terms");
  await expect(page.getByText(/Paddle\.com is the Merchant of Record/)).toBeVisible();
  await page.goto("/privacy");
  await expect(page.getByText(/user_accounts:read, pins:read, boards:read/)).toBeVisible();
  await expect(page.getByText(/kept for at most 90 days/)).toBeVisible();
});
