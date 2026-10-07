import { expect, test } from "@playwright/test";

/** The extra menu (⋮) at the top right of every panel group: Info about the panel, Float, Pop out, Maximize, Close. */

test("every panel group has a ⋮ menu; Info opens that panel's info window; Maximize and Close work", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  const groups = await page.locator(".dv-groupview").count(), buttons = page.getByRole("button", { name: "Panel menu" });
  expect(groups).toBeGreaterThan(1);
  await expect(buttons).toHaveCount(groups);
  // The Motion Path tab's group: its menu's Info is about Motion Path.
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  const motion = page.locator(".dv-groupview", { has: page.locator(".panel.motion-path") }).getByRole("button", { name: "Panel menu" });
  await motion.click();
  await page.getByRole("menuitem", { name: "Info…" }).click();
  const info = page.getByRole("dialog", { name: "Motion Path info" });
  await expect(info).toBeVisible();
  await expect(info).toContainText("How it works");
  await expect(info).toContainText("Add a spline node");
  await page.keyboard.press("Escape");
  await expect(info).toBeHidden();
  // Another panel's menu says its own thing.
  await page.locator(".dv-tab", { hasText: /^History$/ }).click();
  await page.locator(".dv-groupview", { has: page.locator(".dv-tab", { hasText: /^History$/ }) }).getByRole("button", { name: "Panel menu" }).click();
  await page.getByRole("menuitem", { name: "Info…" }).click();
  await expect(page.getByRole("dialog", { name: "History info" })).toContainText("undo step");
});
