import { expect, test } from "@playwright/test";

/** View ▸ Full Screen (and ⇧⌘F): the browser's full screen, which hides its address and tab bars. */

test("View ▸ Full Screen enters the browser's full screen and the menu shows it checked; choosing it again, or the key, leaves", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const full = () => page.evaluate(() => document.fullscreenElement !== null);
  expect(await full()).toBe(false);
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: /Full Screen(?! on Start)/ }).click();
  await expect.poll(full).toBe(true);
  // The window settles into full screen (it resizes, which closes an open menu).
  await page.waitForTimeout(600);
  await page.getByRole("button", { name: "View", exact: true }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: /Full Screen(?! on Start)/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemcheckbox", { name: /Full Screen(?! on Start)/ }).click();
  await expect.poll(full).toBe(false);
  await page.waitForTimeout(600);
  // The key does the same.
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await expect.poll(full).toBe(true);
  await page.keyboard.press("ControlOrMeta+Shift+F");
  await expect.poll(full).toBe(false);
});

test("by default the first click goes full screen (once: leaving it keeps it left); View ▸ Full Screen on Start changes the default", async ({ page }) => {
  await page.goto("/?fullscreen");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  const full = () => page.evaluate(() => document.fullscreenElement !== null);
  expect(await full()).toBe(false);
  // The first click anywhere in the page.
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect.poll(full).toBe(true);
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  // Leave it: further clicks do not bring it back.
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(full).toBe(false);
  await page.waitForTimeout(500);
  await page.locator(".outline .row", { hasText: "hips" }).first().click();
  await page.waitForTimeout(300);
  expect(await full()).toBe(false);
  // Change the default: the menu's check goes off and is remembered; a fresh load's first click stays windowed.
  await page.getByRole("button", { name: "View", exact: true }).click();
  const item = page.getByRole("menuitemcheckbox", { name: /Full Screen on Start/ });
  await expect(item).toHaveAttribute("aria-checked", "true");
  await item.click();
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await page.waitForTimeout(500);
  expect(await full()).toBe(false);
  await page.getByRole("button", { name: "View", exact: true }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: /Full Screen on Start/ })).toHaveAttribute("aria-checked", "false");
});

test("an automated browser is not sent full screen unless asked, so the other tests keep their window", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.fullscreenElement !== null)).toBe(false);
});
