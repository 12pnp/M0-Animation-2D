import { expect, test } from "@playwright/test";

/** The stage's Lock (Animate mode only, key L): the selected bone cannot be let go or swapped for another until it is unlocked. */

type Live = { boneburst: { session: { selectedBone: string | null; selectionLocked: boolean; select(s: unknown): void; animation: unknown } } };

const selected = (page: import("@playwright/test").Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.selectedBone);

test("Lock shows in Animate mode only; locked, the bone cannot be swapped, let go or replaced from the rig list, the stage or Escape; L or the button unlocks", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const lock = page.locator(".stage-lock");
  // Pose mode: no lock.
  await expect(lock).toBeHidden();
  await page.locator(".stage-panel button.mode").click();
  await expect(lock).toBeVisible();
  // Nothing selected: nothing to hold.
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select(null));
  await expect(lock).toBeDisabled();
  await page.locator(".outline .row", { hasText: "hips" }).first().click();
  expect(await selected(page)).toBe("hips");
  await expect(lock).toBeEnabled();
  await page.keyboard.press("l");
  await expect(lock).toHaveText("Locked");
  await expect(lock).toHaveAttribute("aria-pressed", "true");
  // Another bone from the rig list, a click on empty stage, Escape, a selection from code: none changes it.
  await page.locator(".outline .row", { hasText: "head" }).first().click();
  expect(await selected(page)).toBe("hips");
  await expect(page.locator(".message")).toContainText("locked");
  const box = (await page.locator(".stage canvas.overlay").boundingBox())!;
  await page.mouse.click(box.x + 6, box.y + box.height - 40);
  expect(await selected(page)).toBe("hips");
  await page.keyboard.press("Escape");
  expect(await selected(page)).toBe("hips");
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select(null));
  expect(await selected(page)).toBe("hips");
  // L unlocks (the button too); then another bone can be picked.
  await page.keyboard.press("l");
  await expect(lock).toHaveText("Lock");
  await page.locator(".outline .row", { hasText: "head" }).first().click();
  expect(await selected(page)).toBe("head");
  await lock.click();
  await expect(lock).toHaveText("Locked");
  await lock.click();
  await expect(lock).toHaveText("Lock");
  // Locked, then back to Pose: the lock lets go with Animate mode.
  await lock.click();
  await page.locator(".stage-panel button.mode").click();
  await expect(lock).toBeHidden();
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.selectionLocked)).toBe(false);
  await page.locator(".outline .row", { hasText: "hips" }).first().click();
  expect(await selected(page)).toBe("hips");
});
