import { expect, type Page, test } from "@playwright/test";
import { startEditPath } from "./motionHelpers";

/** TwinSpline (docs/TWINSPLINE-PLAN.md): a speed for each node of the ring spline, in a graph under the node numbers; the line above them is dragged. */

type Node = { x: number; y: number; speed?: number };
type Live = { boneburst: { session: { sidecar: { motion: { nodes: Node[] }[] }; select(s: unknown): void; history: { undo(): boolean }; changed(): void }; motionPath: { speedPoints: { i: number; x: number; y: number }[] } } };

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => localStorage.clear());
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "head" }));
}

const nodes = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.sidecar.motion[0]?.nodes ?? []);
const dots = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.motionPath.speedPoints);

test("Adjust time is gone: Edit Path is the one mode, with Total frames, Closed and Bake beside it", async ({ page }) => {
  await open(page);
  const panel = page.locator(".panel.motion-path");
  await startEditPath(panel);
  await expect(panel.getByRole("button", { name: "Adjust time" })).toHaveCount(0);
  await expect(panel.getByRole("button", { name: /Time$/ })).toHaveCount(0);
  await expect(panel.getByRole("spinbutton", { name: "Total frames" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Bake to timeline" })).toBeVisible();
});

test("a speed for each node: a point in the graph, the Speed field, a drag, a double click back to 0, all held to -0.99 and 5, each one undo step", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  await open(page);
  const panel = page.locator(".panel.motion-path");
  await startEditPath(panel);
  await panel.getByRole("button", { name: "Add a spline node" }).click();
  await expect(panel.locator(".lp-speed-canvas")).toBeVisible();
  await expect.poll(async () => (await dots(page)).length).toBe(3);
  expect((await nodes(page)).every((n) => !n.speed)).toBe(true);
  // The Speed field of the picked node; out of range is held to the limits.
  await panel.locator(".lp-slots button.node").nth(1).click();
  await expect(panel.locator(".lp-fields .title")).toContainText("Node 2");
  const field = panel.getByLabel("Node speed");
  await field.fill("2.5");
  await field.press("Enter");
  await expect.poll(async () => (await nodes(page))[1]!.speed).toBe(2.5);
  await expect(panel.locator(".lp-fields .read")).toHaveText("×3.5");
  await field.fill("9");
  await field.press("Enter");
  await expect.poll(async () => (await nodes(page))[1]!.speed).toBe(5);
  await field.fill("-4");
  await field.press("Enter");
  await expect.poll(async () => (await nodes(page))[1]!.speed).toBe(-0.99);
  // Drag node 3's point up with the mouse: its speed rises.
  const box = (await panel.locator(".lp-speed-canvas").boundingBox())!;
  await page.waitForTimeout(200);
  const d = (await dots(page)).find((q) => q.i === 2)!;
  await page.mouse.move(box.x + d.x, box.y + d.y);
  await page.mouse.down();
  await page.mouse.move(box.x + d.x, box.y + d.y - 40, { steps: 5 });
  await page.mouse.up();
  const raised = (await nodes(page))[2]!.speed ?? 0;
  expect(raised).toBeGreaterThan(0.3);
  expect(raised).toBeLessThanOrEqual(5);
  // A double click on the point puts it back to 0.
  await page.waitForTimeout(200);
  const e = (await dots(page)).find((q) => q.i === 2)!;
  await page.mouse.dblclick(box.x + e.x, box.y + e.y);
  await expect.poll(async () => (await nodes(page))[2]!.speed ?? 0).toBe(0);
  // Undo takes the double click back, then the drag as one step.
  await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; s.history.undo(); s.changed(); });
  expect((await nodes(page))[2]!.speed).toBe(raised);
  await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; s.history.undo(); s.changed(); });
  expect((await nodes(page))[2]!.speed ?? 0).toBe(0);
});

test("a node added after the picked one takes the speed spline's value there: the pace along the path stays", async ({ page }) => {
  await open(page);
  const panel = page.locator(".panel.motion-path");
  await startEditPath(panel);
  await panel.locator(".lp-slots button.node").nth(0).click();
  await expect(panel.locator(".lp-fields .title")).toContainText("Node 1");
  await panel.getByLabel("Node speed").fill("2");
  await panel.getByLabel("Node speed").press("Enter");
  await panel.locator(".lp-slots button.node").nth(1).click();
  await expect(panel.locator(".lp-fields .title")).toContainText("Node 2");
  await panel.getByLabel("Node speed").fill("2");
  await panel.getByLabel("Node speed").press("Enter");
  await expect.poll(async () => (await nodes(page)).map((n) => n.speed ?? 0)).toEqual([2, 2]);
  await panel.locator(".lp-slots button.node").nth(0).click();
  await panel.getByRole("button", { name: "Add a spline node" }).click();
  // Between two nodes at 2, the curve is at 2: the new one has 2.
  await expect.poll(async () => (await nodes(page)).map((n) => n.speed ?? 0)).toEqual([2, 2, 2]);
});

test("the line above the node numbers is dragged: the area under it grows and the picture gives up the room; double-click puts it back; it is kept", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  await open(page);
  const panel = page.locator(".panel.motion-path");
  await startEditPath(panel);
  const split = panel.locator(".lp-split"), lower = panel.locator(".lp-lower"), body = panel.locator(".lp-body");
  await expect(split).toBeVisible();
  const h0 = (await lower.boundingBox())!.height, p0 = (await body.boundingBox())!.height;
  const s = (await split.boundingBox())!, x = s.x + s.width / 2, y = s.y + s.height / 2;
  // Down: the area under the line shrinks and the picture takes the room.
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 50, { steps: 6 });
  await page.mouse.up();
  const h1 = (await lower.boundingBox())!.height, p1 = (await body.boundingBox())!.height;
  expect(h1).toBeLessThan(h0 - 30);
  expect(p1).toBeGreaterThan(p0 + 30);
  // Up again past where it began: it grows, and the picture gives the room (never below its least).
  const s1 = (await split.boundingBox())!;
  await page.mouse.move(s1.x + s1.width / 2, s1.y + s1.height / 2);
  await page.mouse.down();
  await page.mouse.move(s1.x + s1.width / 2, s1.y - 300, { steps: 6 });
  await page.mouse.up();
  const h2 = (await lower.boundingBox())!.height, p2 = (await body.boundingBox())!.height;
  expect(h2).toBeGreaterThan(h1 + 20);
  expect(p2).toBeGreaterThanOrEqual(118);
  // Far down: not below its least.
  const s2 = (await split.boundingBox())!;
  await page.mouse.move(s2.x + s2.width / 2, s2.y + s2.height / 2);
  await page.mouse.down();
  await page.mouse.move(s2.x + s2.width / 2, s2.y + 900, { steps: 6 });
  await page.mouse.up();
  expect((await lower.boundingBox())!.height).toBeGreaterThanOrEqual(149);
  // Kept for the next time.
  expect(await page.evaluate(() => Number(localStorage.getItem("boneburst.motionPath.lower")))).toBeGreaterThanOrEqual(150);
  // Back to the usual by a double click.
  const s3 = (await split.boundingBox())!;
  await page.mouse.dblclick(s3.x + s3.width / 2, s3.y + s3.height / 2);
  await expect.poll(async () => Math.round((await lower.boundingBox())!.height)).toBe(Math.round(h0));
});
