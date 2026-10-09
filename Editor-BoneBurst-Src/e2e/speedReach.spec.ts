import { expect, type Page, test } from "@playwright/test";

/**
 * A leg's reach on a straight span (docs/FRAMEPATH-SPEED-PLAN.md, step 10): typed in the data row or set in the Curves view by a handle's
 * place across (docs/CURVES-PANEL-PLAN.md, steps 3 and 8; the speed graph is a preview with no legs).
 */

type Live = { boneburst: { session: { select(s: unknown): void; seek(f: number): void; fps: number; doc: { animations: { bones?: { name: string; timelines: { name: string; keys: { time?: number; x?: number; y?: number; curve?: unknown }[] }[] }[] }[] } }; motionPath: { speedPoints: readonly { i: number; x: number; y: number }[]; curveHandles: readonly { side: "in" | "out"; x: number; y: number }[] } } };

const keyJson = (page: Page) => page.evaluate(() => JSON.stringify((window as unknown as Live).boneburst.session.doc.animations[0]!.bones!.find((b) => b.name === "hips")!.timelines.find((t) => t.name === "translate")!.keys));

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  const t1 = await page.evaluate(() => (window as unknown as Live).boneburst.session.doc.animations[0]!.bones!.find((b) => b.name === "hips")!.timelines.find((t) => t.name === "translate")!.keys[1]!.time ?? 0);
  await page.evaluate((t) => { const s = (window as unknown as Live).boneburst.session; s.seek(Math.round(t * s.fps)); }, t1);
  // Plain: both of key 2's spans straight.
  await page.locator(".panel.motion-path").getByRole("button", { name: "Plain", exact: true }).click();
}

test("a reach typed in the data row moves the Curves view's out handle across; the speed graph shows no legs (CURVES-PANEL-PLAN step 8)", async ({ page }) => {
  await open(page);
  const panel = page.locator(".panel.motion-path"), reachOut = panel.getByRole("spinbutton", { name: "Reach out" });
  await expect(reachOut).toHaveValue("33.3");
  const out = () => page.evaluate(() => (window as unknown as Live).boneburst.motionPath.curveHandles.find((h) => h.side === "out")?.x ?? Number.NaN);
  await expect.poll(async () => Number.isFinite(await out())).toBe(true);
  const before = await out();
  await reachOut.fill("60");
  await reachOut.press("Enter");
  await expect.poll(out).toBeGreaterThan(before + 20);
  expect(await page.evaluate(() => "speedHandles" in (window as unknown as { boneburst: { motionPath: object } }).boneburst.motionPath)).toBe(false);
});

test("in the Curves view, Shift + dragging the out handle across sets the reach; the keys' places stay", async ({ page }) => {
  await open(page);
  const panel = page.locator(".panel.motion-path"), reachOut = panel.getByRole("spinbutton", { name: "Reach out" });
  await expect(reachOut).toHaveValue("33.3");
  const places = async () => JSON.parse(await keyJson(page)).map((k: { time?: number; x?: number; y?: number }) => [k.time ?? 0, k.x ?? 0, k.y ?? 0]);
  const before = await places();
  await expect.poll(() => page.evaluate(() => (window as unknown as Live).boneburst.motionPath.curveHandles.length)).toBe(2);
  const out = (await page.evaluate(() => (window as unknown as Live).boneburst.motionPath.curveHandles)).find((h) => h.side === "out")!;
  const box = (await panel.locator(".lp-curves-canvas").boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + out.x, box.y + out.y);
  await page.mouse.down();
  await page.mouse.move(box.x + out.x - 25, box.y + out.y + 2, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect.poll(async () => Number(await reachOut.inputValue())).toBeLessThan(25);
  expect(await places()).toEqual(before);
});
