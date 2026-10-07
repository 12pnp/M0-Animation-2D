import { expect, type Page, test } from "@playwright/test";

/** Motion Path's four handle toggles (the Stage's tool icons): each shows or hides its handle on the bone; scale and shear are draggable like the Stage's. */

type Live = { boneburst: { session: { select(s: unknown): void; pose(): { bones: Map<string, number>; local: Float64Array | Float32Array } | null; seek(f: number): void }; motionPath: { grabPoints: { handle: { x: number; y: number } | null; scaleHandle: { x: number; y: number } | null; shearHandle: { x: number; y: number } | null; arrows: unknown[] } } } };

async function open(page: Page, bone = "head"): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate((b) => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: b }), bone);
  await expect(page.locator(".motion-path .lp-head > span").first()).toContainText(bone);
  await page.waitForTimeout(400);
}

const grab = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.motionPath.grabPoints);
const toggle = (page: Page, name: string) => page.locator(".motion-path .lp-head").getByRole("button", { name, exact: true });
const local = (page: Page) => page.evaluate(() => { const s = (window as unknown as Live).boneburst.session, p = s.pose()!, k = p.bones.get("head")! * 7; return [...p.local].slice(k, k + 7); });

test("four icons in the header show or hide the rotate ring, move arrows, scale square and shear diamond; the choice is remembered", async ({ page }) => {
  await open(page);
  for (const name of ["Show rotate handle", "Show move handle", "Show scale handle", "Show shear handle"]) await expect(toggle(page, name)).toHaveAttribute("aria-pressed", "true");
  let g = await grab(page);
  expect(g.handle).not.toBeNull();
  expect(g.scaleHandle).not.toBeNull();
  expect(g.shearHandle).not.toBeNull();
  expect(g.arrows.length).toBe(2);
  // Rotation off: its ring goes, the others stay.
  await toggle(page, "Show rotate handle").click();
  await expect(toggle(page, "Show rotate handle")).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await grab(page)).handle).toBeNull();
  g = await grab(page);
  expect(g.scaleHandle).not.toBeNull();
  expect(g.arrows.length).toBe(2);
  await toggle(page, "Show move handle").click();
  await toggle(page, "Show scale handle").click();
  await toggle(page, "Show shear handle").click();
  await expect.poll(async () => { const x = await grab(page); return [x.handle, x.scaleHandle, x.shearHandle, x.arrows.length]; }).toEqual([null, null, null, 0]);
  // Kept for next time.
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await expect(toggle(page, "Show rotate handle")).toHaveAttribute("aria-pressed", "false");
  await expect(toggle(page, "Show shear handle")).toHaveAttribute("aria-pressed", "false");
});

test("the scale square and the shear diamond are dragged like the Stage's: the bone's scale or shear at the playhead changes", async ({ page }) => {
  await open(page);
  const box = (await page.locator(".motion-path canvas").first().boundingBox())!, before = await local(page);
  const g = await grab(page);
  await page.mouse.move(box.x + g.scaleHandle!.x, box.y + g.scaleHandle!.y);
  await page.mouse.down();
  await page.mouse.move(box.x + g.scaleHandle!.x + 50, box.y + g.scaleHandle!.y + 30, { steps: 6 });
  await page.mouse.up();
  const scaled = await local(page);
  expect(scaled[3] !== before[3] || scaled[4] !== before[4]).toBe(true);
  expect(scaled[5]).toBe(before[5]);
  await page.waitForTimeout(300);
  const h = await grab(page);
  await page.mouse.move(box.x + h.shearHandle!.x, box.y + h.shearHandle!.y);
  await page.mouse.down();
  await page.mouse.move(box.x + h.shearHandle!.x + 40, box.y + h.shearHandle!.y - 20, { steps: 6 });
  await page.mouse.up();
  const sheared = await local(page);
  expect(sheared[5] !== before[5] || sheared[6] !== before[6]).toBe(true);
  expect(sheared[3]).toBe(scaled[3]);
  expect(sheared[4]).toBe(scaled[4]);
  // Hidden, a handle is not there to grab: a press where it was does not scale.
  await toggle(page, "Show scale handle").click();
  await page.waitForTimeout(300);
  const now = await local(page);
  await page.mouse.move(box.x + g.scaleHandle!.x, box.y + g.scaleHandle!.y);
  await page.mouse.down();
  await page.mouse.move(box.x + g.scaleHandle!.x + 60, box.y + g.scaleHandle!.y, { steps: 4 });
  await page.mouse.up();
  expect((await local(page))[3]).toBe(now[3]);
});
