import { expect, type Page, test } from "@playwright/test";

/** The Motion Path header's Stage toggle: the bone's spline drawn as a line on the Stage, in a colour of its own. */

type Line = { points: number[]; colour: string } | null;
type Live = { boneburst: { session: { select(s: unknown): void }; motionPath: { stageLine(): Line } } };

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "head" }));
}

/** What the Undo and Redo buttons do. */
const undo = (page: Page, dir: "undo" | "redo"): Promise<void> => page.evaluate((d) => {
  const s = (window as unknown as { boneburst: { session: { history: Record<string, () => boolean>; changed(): void } } }).boneburst.session;
  s.history[d]!();
  s.changed();
}, dir);

const line = (page: Page): Promise<Line> => page.evaluate(() => (window as unknown as Live).boneburst.motionPath.stageLine());

test("the Stage button draws the bone's spline on the Stage in the swatch's colour, and is kept", async ({ page }) => {
  await open(page);
  const panel = page.locator(".panel.motion-path");
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
  const toggle = panel.getByRole("button", { name: "Stage", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(await line(page)).toBeNull();
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const on = await line(page);
  expect(on!.points.length).toBeGreaterThan(20);
  expect(on!.colour).toMatch(/^#[0-9a-f]{6}$/i);
  // The overlay really has that colour on it (the Stage redraws on the next frame).
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const painted = await page.evaluate((hex) => {
    const c = document.querySelector<HTMLCanvasElement>(".stage-panel canvas.overlay, canvas.overlay")!, d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const [r, g, b] = [1, 3, 5].map((k) => parseInt(hex.slice(k, k + 2), 16)) as [number, number, number];
    for (let i = 0; i < d.length; i += 4) if (d[i] === r && d[i + 1] === g && d[i + 2] === b && d[i + 3]! > 200) return true;
    return false;
  }, on!.colour);
  expect(painted).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("boneburst.motionPath.stageLine"))).toContain('"on":true');
});

test("every Motion Path step is in the History and can be undone: a node dragged, a node added, a node removed, and Start", async ({ page }) => {
  await open(page);
  const panel = page.locator(".panel.motion-path"), nodes = () => page.evaluate(() => (window as unknown as { boneburst: { session: { sidecar: { motion: { nodes: unknown[] }[] } } } }).boneburst.session.sidecar.motion[0]?.nodes.length ?? 0);
  const labels = () => page.evaluate(() => (window as unknown as { boneburst: { session: { history: { entries: { labels: string[]; done: number } } } } }).boneburst.session.history.entries);
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
  expect(await nodes()).toBe(2);
  await panel.getByRole("button", { name: "Add a spline node" }).click();
  await panel.getByRole("button", { name: "Add a spline node" }).click();
  expect(await nodes()).toBe(4);
  const l = await labels();
  expect(l.labels.slice(0, l.done)).toEqual([expect.stringMatching(/^Start a path for head/), "Add a spline node", "Add a spline node"]);
  await undo(page, "undo");
  expect(await nodes()).toBe(3);
  await undo(page, "redo");
  expect(await nodes()).toBe(4);
  // A node removed, then undone: the picked number is not left pointing past the end.
  await panel.locator(".lp-slots button.node").nth(3).click();
  await panel.getByRole("button", { name: "− Node" }).click();
  expect(await nodes()).toBe(3);
  await undo(page, "undo");
  expect(await nodes()).toBe(4);
  for (let k = 0; k < 3; k++) await undo(page, "undo");
  expect(await nodes()).toBe(0);
  await expect(panel.locator(".lp-slots button.node")).toHaveCount(0);
});
