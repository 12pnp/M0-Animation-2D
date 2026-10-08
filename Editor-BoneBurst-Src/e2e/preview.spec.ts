import { expect, test } from "@playwright/test";

/** The Preview panel: the animation playing on a clock of its own, the Timeline's playhead and the Stage left alone. */

type Live = { boneburst: { session: { time: number; playing: boolean; showAnimation(n: string | null): void; doc: { animations?: { name: string }[] } } } };

test("Preview plays the animation on its own clock: it advances, Pause holds it, and the playhead never moves", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; s.showAnimation(s.doc.animations![0]!.name); });
  await page.locator(".dv-tab", { hasText: "Preview" }).click();
  const panel = page.locator(".panel.preview");
  await expect(panel).toBeVisible();
  const clock = panel.locator(".pv-clock");
  await expect(clock).toContainText(" / ");
  const first = await clock.textContent();
  await expect.poll(() => clock.textContent()).not.toBe(first);
  await panel.getByRole("button", { name: "Pause" }).click();
  const held = await clock.textContent();
  await page.waitForTimeout(300);
  expect(await clock.textContent()).toBe(held);
  expect(await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; return [s.time, s.playing]; })).toEqual([0, false]);
  // Its own choice: the setup pose.
  await panel.getByLabel("Preview animation").selectOption("");
  await expect(clock).toHaveText("setup pose");
});

test("Preview's background is one solid colour from three slots: white, grey and one to adjust", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await page.locator(".dv-tab", { hasText: "Preview" }).click();
  const panel = page.locator(".panel.preview"), view = panel.locator(".pv-view");
  await expect(view).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await panel.getByRole("button", { name: "Grey background" }).click();
  await expect(view).toHaveCSS("background-color", "rgb(128, 128, 128)");
  await expect(panel.getByRole("button", { name: "Grey background" })).toHaveAttribute("aria-pressed", "true");
  await panel.getByLabel("Background colour").fill("#102030");
  await expect(view).toHaveCSS("background-color", "rgb(16, 32, 48)");
  await panel.getByRole("button", { name: "White background" }).click();
  await expect(view).toHaveCSS("background-color", "rgb(255, 255, 255)");
  // The adjustable slot keeps its colour.
  await expect(panel.getByLabel("Background colour")).toHaveValue("#102030");
});

test("Preview: ◀ and ▶ change the animation, − and + change the speed it plays at", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await page.locator(".dv-tab", { hasText: "Preview" }).click();
  const panel = page.locator(".panel.preview"), pick = panel.getByLabel("Preview animation");
  await panel.getByRole("button", { name: "Next animation" }).click();
  const a = await pick.inputValue();
  expect(a).not.toBe("");
  await panel.getByRole("button", { name: "Next animation" }).click();
  const b = await pick.inputValue();
  expect(b).not.toBe(a);
  await panel.getByRole("button", { name: "Previous animation" }).click();
  expect(await pick.inputValue()).toBe(a);
  const rate = panel.locator(".pv-rate");
  await expect(rate).toHaveText("×1");
  await panel.getByRole("button", { name: "Faster" }).click();
  await expect(rate).toHaveText("×1.5");
  await panel.getByRole("button", { name: "Slower" }).click();
  await panel.getByRole("button", { name: "Slower" }).click();
  await expect(rate).toHaveText("×0.75");
  await rate.click();
  await expect(rate).toHaveText("×1");
});
