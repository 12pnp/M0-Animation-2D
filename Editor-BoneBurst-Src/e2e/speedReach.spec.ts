import { expect, type Page, test } from "@playwright/test";

/**
 * A leg's reach on a straight span (docs/FRAMEPATH-SPEED-PLAN.md, step 10): the speed graph draws a leg as long as its reach; since the
 * speed graph became a preview (docs/CURVES-PANEL-PLAN.md, step 3) the reach is set in the Curves view, by a handle's place across.
 */

type Live = { boneburst: { session: { select(s: unknown): void; seek(f: number): void; fps: number; doc: { animations: { bones?: { name: string; timelines: { name: string; keys: { time?: number; x?: number; y?: number; curve?: unknown }[] }[] }[] }[] } }; motionPath: { speedPoints: readonly { i: number; x: number; y: number }[]; speedHandles: readonly { i: number; side: "in" | "out"; x: number; y: number }[]; curveHandles: readonly { side: "in" | "out"; x: number; y: number }[] } } };

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

test("the speed graph draws a leg as long as its reach; dragging that leg there changes nothing", async ({ page }) => {
  await open(page);
  const panel = page.locator(".panel.motion-path"), reachOut = panel.getByRole("spinbutton", { name: "Reach out" });
  await expect(reachOut).toHaveValue("33.3");
  await panel.getByRole("button", { name: "Node", exact: true }).click();
  const leg = () => page.evaluate(() => (window as unknown as Live).boneburst.motionPath.speedHandles.find((h) => h.i === 1 && h.side === "out")!);
  const dot = () => page.evaluate(() => (window as unknown as Live).boneburst.motionPath.speedPoints.find((p) => p.i === 1)!);
  await expect.poll(async () => (await leg()).x - (await dot()).x).toBeGreaterThan(22);
  const before = await leg(), d = await dot(), keys = await keyJson(page), box = (await panel.locator(".lp-speed-canvas").boundingBox())!;
  await page.mouse.move(box.x + before.x, box.y + before.y);
  await page.mouse.down();
  await page.mouse.move(box.x + before.x - 30, box.y + before.y - 20, { steps: 5 });
  await page.mouse.up();
  expect(await keyJson(page)).toBe(keys);
  // The press was a click in the span: the playhead moved into it. Back on key 2, a reach typed in the data row: the leg follows.
  const t1 = await page.evaluate(() => (window as unknown as Live).boneburst.session.doc.animations[0]!.bones!.find((b) => b.name === "hips")!.timelines.find((t) => t.name === "translate")!.keys[1]!.time ?? 0);
  await page.evaluate((t) => { const s = (window as unknown as Live).boneburst.session; s.seek(Math.round(t * s.fps)); }, t1);
  await reachOut.fill("50");
  await reachOut.press("Enter");
  await expect.poll(async () => (await leg()).x - d.x).toBeGreaterThan((before.x - d.x) * 1.3);
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
