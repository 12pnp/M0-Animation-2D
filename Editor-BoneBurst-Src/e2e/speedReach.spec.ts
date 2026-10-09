import { expect, type Page, test } from "@playwright/test";

/** A speed-graph leg's length is its reach on a straight span (docs/FRAMEPATH-SPEED-PLAN.md, step 10): dragged sideways it changes, its speed does not. */

type Live = { boneburst: { session: { select(s: unknown): void; seek(f: number): void; fps: number; doc: { animations: { bones?: { name: string; timelines: { name: string; keys: { time?: number }[] }[] }[] }[] } }; motionPath: { speedPoints: readonly { i: number; x: number; y: number }[]; speedHandles: readonly { i: number; side: "in" | "out"; x: number; y: number }[] } } };

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
}

test("a leg dragged sideways on a straight span sets its reach and keeps its speed; the leg is drawn as long as the reach", async ({ page }) => {
  await open(page);
  const panel = page.locator(".panel.motion-path");
  const t1 = await page.evaluate(() => (window as unknown as Live).boneburst.session.doc.animations[0]!.bones!.find((b) => b.name === "hips")!.timelines.find((t) => t.name === "translate")!.keys[1]!.time ?? 0);
  await page.evaluate((t) => { const s = (window as unknown as Live).boneburst.session; s.seek(Math.round(t * s.fps)); }, t1);
  // Plain: both spans straight.
  await panel.getByRole("button", { name: "Plain", exact: true }).click();
  const reachOut = panel.getByRole("spinbutton", { name: "Reach out" }), speedOut = panel.getByRole("spinbutton", { name: "Speed out" });
  await expect(reachOut).toBeEnabled();
  await expect(reachOut).toHaveValue("33.3");
  const speed = Number(await speedOut.inputValue());
  // Only the picked key has legs on the graph (step 12).
  expect(await page.evaluate(() => [...new Set((window as unknown as Live).boneburst.motionPath.speedHandles.map((h) => h.i))])).toEqual([1]);
  // The picked key's span across the graph, so its legs are long enough to grab.
  await panel.getByRole("button", { name: "Node", exact: true }).click();
  const leg = async () => page.evaluate(() => (window as unknown as Live).boneburst.motionPath.speedHandles.find((h) => h.i === 1 && h.side === "out")!);
  const dotOf = () => page.evaluate(() => (window as unknown as Live).boneburst.motionPath.speedPoints.find((p) => p.i === 1)!);
  // Fitted, a third of the span is further out than the 22 px stem a curved side gets.
  await expect.poll(async () => (await leg()).x - (await dotOf()).x).toBeGreaterThan(22);
  const dot = await dotOf(), before = await leg();
  const box = (await panel.locator(".lp-speed-canvas").boundingBox())!;
  await page.mouse.move(box.x + before.x, box.y + before.y);
  await page.mouse.down();
  await page.mouse.move(box.x + before.x - (before.x - dot.x) / 2, box.y + before.y, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Number(await reachOut.inputValue())).toBeLessThan(25);
  expect(Number(await speedOut.inputValue())).toBeCloseTo(speed, 1);
  const after = await leg();
  expect(after.x - dot.x).toBeLessThan((before.x - dot.x) * 0.75);
  // Typed in the data row: read back, and the leg follows.
  await reachOut.fill("50");
  await reachOut.press("Enter");
  await expect.poll(async () => (await leg()).x - dot.x).toBeGreaterThan((before.x - dot.x) * 1.3);
});
