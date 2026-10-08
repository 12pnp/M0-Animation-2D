import { expect, type Page, test } from "@playwright/test";
import { chooseParent, startEditPath, twinMenu } from "./motionHelpers";

/** The Motion Path header's Stage toggle: the bone's spline drawn as a line on the Stage, in a colour of its own. */

type Line = { points: number[]; colour: string } | null;
type Live = { boneburst: { session: { select(s: unknown): void }; motionPath: { stageLine(): Line } } };

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  // The page being left wrote its remembered view as it went: this one starts clean.
  await page.evaluate(() => localStorage.clear());
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
  await startEditPath(panel);
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
  await startEditPath(panel);
  expect(await nodes()).toBe(2);
  await twinMenu(panel, "Add a spline node");
  await twinMenu(panel, "Add a spline node");
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

test("the Spline button hides and shows the spline in Motion Path, and leaves the bone's own path (Path) as it is", async ({ page }) => {
  await open(page);
  const panel = page.locator(".panel.motion-path"), spline = panel.getByRole("button", { name: "Spline", exact: true }), path = panel.getByRole("button", { name: "Path", exact: true });
  await startEditPath(panel);
  await expect(spline).toHaveAttribute("aria-pressed", "true");
  await spline.click();
  await expect(spline).toHaveAttribute("aria-pressed", "false");
  await expect(path).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => localStorage.getItem("boneburst.motionPath.layers"))).toContain('"spline":false');
  // The other way round: the path off, the spline on, and its nodes can still be grabbed on the canvas.
  await spline.click();
  await path.click();
  await expect(path).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => page.evaluate(() => (window as unknown as { boneburst: { motionPath: { grabPoints: { nodes: unknown[] } } } }).boneburst.motionPath.grabPoints.nodes.length)).toBeGreaterThan(0);
});

test("Motion Path's keys, with the pointer over it: A starts the path and adds, V reverses, X removes", async ({ page }) => {
  await open(page);
  const panel = page.locator(".panel.motion-path");
  const motion = () => page.evaluate(() => { const m = (window as unknown as { boneburst: { session: { sidecar: { motion: { nodes: { id?: number }[] }[] } } } }).boneburst.session.sidecar.motion[0]; return m ? m.nodes.map((n, i) => n.id ?? i + 1) : null; });
  await chooseParent(panel);
  const box = (await panel.locator(".lp-body canvas").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press("a");
  expect(await motion()).toEqual([1, 2]);
  await page.keyboard.press("a");
  await page.keyboard.press("a");
  expect(await motion()).toEqual([1, 2, 3, 4]);
  await page.keyboard.press("v");
  expect(await motion()).toEqual([1, 4, 3, 2]);
  // The node added last is the picked one: X removes it.
  await page.keyboard.press("x");
  expect((await motion())!.length).toBe(3);
  // The digits, C and E (Adjust time is gone) are not this panel's.
  await page.keyboard.press("Digit2");
  await page.keyboard.press("c");
  await page.keyboard.press("e");
  expect((await motion())!.length).toBe(3);
  // Away from the panel the same keys are not this panel's.
  await page.mouse.move(2, 2);
  await page.keyboard.press("a");
  expect((await motion())!.length).toBe(3);
});

test("Break the legs: the right-click menu breaks a node's legs and mirrors them again; Alt + drag a handle moves only that leg; undo takes it back", async ({ page }) => {
  await open(page);
  const panel = page.locator(".panel.motion-path");
  type N = { tx?: number; ty?: number; bx?: number; by?: number };
  const node = (i: number) => page.evaluate((k) => (window as unknown as { boneburst: { session: { sidecar: { motion: { nodes: N[] }[] } } } }).boneburst.session.sidecar.motion[0]!.nodes[k]!, i);
  await startEditPath(panel);
  expect((await node(0)).bx).toBeUndefined();
  await panel.locator(".lp-slots button.node").nth(0).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Break the legs of 1" }).click();
  const broken = await node(0);
  expect(broken.bx).toBeDefined();
  // Drag the way-out handle: the way in stays where it was (mirrored, it would have turned with it).
  await page.waitForTimeout(400);
  const handles = await page.evaluate(() => (window as unknown as { boneburst: { motionPath: { grabPoints: { handles: { slot: number; side: string; x: number; y: number }[] } } } }).boneburst.motionPath.grabPoints.handles.filter((h) => h.slot === 0));
  const hin = handles.find((h) => h.side === "out")!, box = (await panel.locator(".lp-body canvas").boundingBox())!;
  await page.mouse.move(box.x + hin.x, box.y + hin.y);
  await page.mouse.down();
  await page.mouse.move(box.x + hin.x + 25, box.y + hin.y + 25, { steps: 4 });
  await page.mouse.up();
  const after = await node(0);
  expect(after.tx).not.toBe(broken.tx);
  expect(after.bx).toBe(broken.bx);
  expect(after.by).toBe(broken.by);
  await panel.locator(".lp-slots button.node").nth(0).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Mirror the legs of 1" }).click();
  expect((await node(0)).bx).toBeUndefined();
  await undo(page, "undo");
  expect((await node(0)).bx).toBeDefined();
  await undo(page, "undo");
  await undo(page, "undo");
  expect((await node(0)).bx).toBeUndefined();
  // Alt + drag a handle of a mirrored node breaks it first.
  await page.waitForTimeout(400);
  const out = (await page.evaluate(() => (window as unknown as { boneburst: { motionPath: { grabPoints: { handles: { slot: number; side: string; x: number; y: number }[] } } } }).boneburst.motionPath.grabPoints.handles)).find((h) => h.slot === 0 && h.side === "out")!;
  await page.keyboard.down("Alt");
  await page.mouse.move(box.x + out.x, box.y + out.y);
  await page.mouse.down();
  await page.mouse.move(box.x + out.x + 20, box.y + out.y - 20, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Alt");
  expect((await node(0)).bx).toBeDefined();
});

test("the node numbers sit under the picture and the picked node's data under them: place, both handles, legs; a field commits as one undo step", async ({ page }) => {
  await open(page);
  const panel = page.locator(".panel.motion-path");
  await startEditPath(panel);
  await expect(panel.locator(".lp-slots button.node").first()).toBeVisible();
  await expect(panel.locator(".lp-data")).toBeVisible();
  const canvas = (await panel.locator(".lp-body").boundingBox())!, strip = (await panel.locator(".lp-slots").boundingBox())!, data = (await panel.locator(".lp-data").boundingBox())!;
  expect(strip.y).toBeGreaterThanOrEqual(canvas.y + canvas.height - 1);
  expect(data.y).toBeGreaterThanOrEqual(strip.y + strip.height - 1);
  const node = (k: number) => page.evaluate((i) => (window as unknown as { boneburst: { session: { sidecar: { motion: { nodes: { x: number; y: number; bx?: number }[] }[] } } } }).boneburst.session.sidecar.motion[0]!.nodes[i]!, k);
  await panel.locator(".lp-slots button.node").nth(1).click();
  await expect(panel.locator(".lp-fields .title")).toContainText("Node 2");
  const x = panel.locator(".lp-data").getByLabel("Node x");
  await x.fill("123.5");
  await x.press("Enter");
  expect((await node(1)).x).toBe(123.5);
  await expect(panel.locator(".lp-data").getByLabel("Way in, x")).toBeDisabled();
  await panel.locator(".lp-data").getByRole("button", { name: "Break legs" }).click();
  expect((await node(1)).bx).toBeDefined();
  await expect(panel.locator(".lp-data").getByLabel("Way in, x")).toBeEnabled();
  const before = (await node(1)).bx;
  const inx = panel.locator(".lp-data").getByLabel("Way in, x");
  await inx.fill("17");
  await inx.press("Enter");
  expect((await node(1)).bx).toBe(17);
  expect(before).not.toBe(17);
  await undo(page, "undo");
  expect((await node(1)).bx).toBe(before);
});
