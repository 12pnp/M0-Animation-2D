import { expect, test } from "@playwright/test";

test("the Open dialog lists the basic stickman first, and it opens the rig", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "File", exact: true }).click();
  await page.getByRole("menuitem", { name: /^Open…/ }).click();
  const dialog = page.getByRole("dialog", { name: "Open Project" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Stickman (basic sample)" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
});
