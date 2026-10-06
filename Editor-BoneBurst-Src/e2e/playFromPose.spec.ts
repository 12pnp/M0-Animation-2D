import { expect, test } from "@playwright/test";

/** Play in Pose mode: it switches to Animate (the last animation shown, or the first), then plays. */

type Live = { boneburst: { session: { playing: boolean; animation: { name: string } | null; showAnimation(n: string | null): void } } };
const state = (page: import("@playwright/test").Page) => page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; return { playing: s.playing, animation: s.animation?.name ?? null }; });

test("the Timeline's Play, in Pose mode, changes to Animate and plays; Pause stops; Pose and Play again comes back to the same animation", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const mode = page.locator(".stage-panel button.mode"), play = page.locator(".timeline").getByRole("button", { name: /^Play/ });
  await expect(mode).toHaveText("Pose");
  expect((await state(page)).animation).toBeNull();
  // Play is there in Pose mode.
  await expect(play).toBeEnabled();
  await play.click();
  await expect(mode).toHaveText("Animate");
  await expect.poll(() => state(page)).toMatchObject({ playing: true });
  const first = (await state(page)).animation!;
  expect(first).not.toBeNull();
  // Pause, then pick another animation, back to Pose, Play: it comes back to that one.
  await page.locator(".timeline").getByRole("button", { name: /^Pause/ }).click();
  expect((await state(page)).playing).toBe(false);
  const other = await page.evaluate((cur) => {
    const s = (window as unknown as { boneburst: { session: { doc: { animations: { name: string }[] } } } }).boneburst.session;
    return s.doc.animations.map((a) => a.name).find((n) => n !== cur) ?? null;
  }, first);
  if (other) {
    await page.evaluate((n) => (window as unknown as Live).boneburst.session.showAnimation(n), other);
    await mode.click();
    await expect(mode).toHaveText("Pose");
    await page.locator(".timeline").getByRole("button", { name: /^Play/ }).click();
    await expect.poll(() => state(page)).toMatchObject({ playing: true, animation: other });
  }
  // Space does the same from Pose mode.
  await page.keyboard.press("Space");
  await mode.click();
  await expect(mode).toHaveText("Pose");
  await page.locator(".stage canvas.overlay").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Space");
  await expect(mode).toHaveText("Animate");
  await expect.poll(() => state(page)).toMatchObject({ playing: true });
});
