import { expect, type Page, test } from "@playwright/test";

/**
 * The History panel (E7-PLAN step 1): its tab, behind the Rig panel's, lists the steps under "Opened …"; a click
 * on an earlier step goes back to it, the later ones greyed and still there; a click on the last
 * comes back; a new edit after going back drops the steps after it.
 */

type Live = { boneburst: { session: any } };

/** Three edits, as three undo steps: hips moved to x 10, 20, 30. */
const edit = (page: Page) => page.evaluate(async () => {
  const bonesUrl = "/src/edit/bones.ts";
  const { updateBone } = await import(/* @vite-ignore */ bonesUrl);
  const s = (window as unknown as Live).boneburst.session;
  for (const x of [10, 20, 30]) { s.history.apply(`Move hips to ${x}`, updateBone("hips", { x })); s.changed(); }
});
const hipsX = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.doc.bones.find((b: { name: string }) => b.name === "hips").x ?? 0);

test("History: the steps listed; a click goes back and forward; a new edit drops the steps after", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const opened = await hipsX(page);
  await edit(page);

  // Open in the default layout, behind the Rig panel's tab.
  await page.locator(".dv-tab", { hasText: "History" }).click();
  const steps = page.locator(".history-step");
  await expect(steps).toHaveText(["Opened Stickman_IK.json", "Move hips to 10", "Move hips to 20", "Move hips to 30"]);
  await expect(steps.nth(3)).toHaveAttribute("aria-current", "step");

  // Back to the first edit: two undone, greyed, still listed.
  await steps.nth(1).click();
  expect(await hipsX(page)).toBe(10);
  await expect(steps.nth(1)).toHaveAttribute("aria-current", "step");
  await expect(page.locator(".history-step.undone")).toHaveCount(2);
  // Back to the file as opened, and forward again to the last.
  await steps.nth(0).click();
  expect(await hipsX(page)).toBe(opened);
  await steps.nth(3).click();
  expect(await hipsX(page)).toBe(30);
  // The toolbar's Undo agrees with the panel.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(steps.nth(2)).toHaveAttribute("aria-current", "step");

  // A new edit after going back: the steps after it are dropped.
  await steps.nth(1).click();
  await page.evaluate(async () => {
    const bonesUrl = "/src/edit/bones.ts";
    const { updateBone } = await import(/* @vite-ignore */ bonesUrl);
    const s = (window as unknown as Live).boneburst.session;
    s.history.apply("Move hips to 99", updateBone("hips", { x: 99 }));
    s.changed();
  });
  await expect(steps).toHaveText(["Opened Stickman_IK.json", "Move hips to 10", "Move hips to 99"]);
});
