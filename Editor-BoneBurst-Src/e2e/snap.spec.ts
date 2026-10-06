import { expect, type Page, test } from "@playwright/test";

/**
 * Snapping and the grid (E6-PLAN step 4e): a bone dragged with the Move tool near a guide lands
 * on it; with Snapping off it lands where the pointer let go; View ▸ Grid draws lines behind.
 */

type Live = { boneburst: {
  session: { pose(): { bones: Map<string, number>; rig: { world: Float64Array } } | null; sidecar: { guides: { axis: string; at: number }[] }; setSidecar(s: unknown): void; selectBone(n: string): void };
  stage: { camera: { x: number; y: number; zoom: number } };
} };

/** The bone's world origin. */
const origin = (page: Page, bone: string) => page.evaluate((b) => {
  const p = (window as unknown as Live).boneburst.session.pose()!, i = p.bones.get(b)! * 6;
  return [p.rig.world[i + 4]!, p.rig.world[i + 5]!] as [number, number];
}, bone);

/** A world point on the page. */
async function screen(page: Page, w: readonly [number, number]): Promise<{ x: number; y: number }> {
  const box = (await page.locator(".stage canvas.overlay").boundingBox())!;
  const cam = await page.evaluate(() => (window as unknown as Live).boneburst.stage.camera);
  return { x: box.x + box.width / 2 + (w[0] - cam.x) * cam.zoom, y: box.y + box.height / 2 - (w[1] - cam.y) * cam.zoom };
}

async function drag(page: Page, from: readonly [number, number], by: readonly [number, number]): Promise<void> {
  const a = await screen(page, from), cam = await page.evaluate(() => (window as unknown as Live).boneburst.stage.camera);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + by[0] * cam.zoom, a.y - by[1] * cam.zoom, { steps: 6 });
  await page.mouse.up();
}

test("a bone dragged near a guide snaps onto it; with Snapping off it does not; View ▸ Grid draws", async ({ page }) => {
  await page.goto("/");
  // The stage panels off: on this small stage they would cover the bone being dragged.
  await page.evaluate(() => localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, stagePanels: false })));
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.selectBone("head"));
  const [hx, hy] = await origin(page, "head");
  const cam = await page.evaluate(() => (window as unknown as Live).boneburst.stage.camera);
  // A vertical guide 30 units right of the head; the drag lets go 2 screen pixels short of it.
  const at = Math.round(hx) + 30;
  await page.evaluate((x) => { const s = (window as unknown as Live).boneburst.session; s.setSidecar({ ...s.sidecar, guides: [{ axis: "x", at: x }] }); }, at);
  await drag(page, [hx, hy], [at - hx - 2 / cam.zoom, 0]);
  expect((await origin(page, "head"))[0]).toBeCloseTo(at, 3);

  // Snapping off (View ▸ Snapping): back, then the same drag stops short.
  await page.keyboard.press("ControlOrMeta+z");
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitemcheckbox").filter({ hasText: /^\W?Snapping/ }).click();
  await drag(page, [hx, hy], [at - hx - 2 / cam.zoom, 0]);
  const off = (await origin(page, "head"))[0];
  expect(Math.abs(off - at)).toBeGreaterThan(1 / cam.zoom);

  // The grid: the stage's pixels change when it is shown.
  const shot = async () => page.locator(".stage canvas:not(.overlay)").screenshot();
  const before = await shot();
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitemcheckbox").filter({ hasText: /^\W?Grid$/ }).click();
  await page.waitForTimeout(150);
  expect((await shot()).equals(before)).toBe(false);
});
