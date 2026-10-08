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
  await panel.getByRole("button", { name: /Pause/ }).click();
  const held = await clock.textContent();
  await page.waitForTimeout(300);
  expect(await clock.textContent()).toBe(held);
  expect(await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; return [s.time, s.playing]; })).toEqual([0, false]);
  // Its own choice: the setup pose.
  await panel.getByLabel("Preview animation").selectOption("");
  await expect(clock).toHaveText("setup pose");
});
