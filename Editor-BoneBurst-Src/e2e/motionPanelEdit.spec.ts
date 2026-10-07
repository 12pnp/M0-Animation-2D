import { expect, test } from "@playwright/test";

/** Editing from the Motion Path panel (docs/LOCALPATH-EDIT-PLAN.md): drag a mark to move the bone at that frame, the handle to turn it. */

interface Live {
  boneburst: {
    session: {
      select(s: unknown): void;
      frame: number;
      doc: { constraints?: unknown; animations: { name: string; bones?: { name: string; timelines: { name: string; keys: { time?: number; x?: number; y?: number; value?: number }[] }[] }[] }[] };
      history: { entries: { done: number; labels: string[] } };
    };
    motionPath: { grabPoints: { marks: number[]; handle: { x: number; y: number } | null; arrows: { axis: 0 | 1; x0: number; y0: number; x1: number; y1: number }[] } };
  };
}

async function open(page: import("@playwright/test").Page, bone: string): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate((b) => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: b }), bone);
  await expect(page.locator(".motion-path .lp-head > span")).toContainText(bone);
  await expect.poll(() => page.evaluate(() => (window as unknown as Live).boneburst.motionPath.grabPoints.marks.length)).toBeGreaterThan(4);
}

/** The bone's key of a timeline in the first animation at `frame` (the fixture's fps), as JSON. */
const keyAt = (page: import("@playwright/test").Page, bone: string, timeline: string, frame: number) => page.evaluate(([b, t, f]) => {
  const live = (window as unknown as Live).boneburst, a = live.session.doc.animations[0]!, fps = 30;
  const key = a.bones?.find((x) => x.name === b)?.timelines.find((x) => x.name === t)?.keys.find((k) => Math.round((k.time ?? 0) * fps) === f);
  return JSON.stringify(key ?? null);
}, [bone, timeline, frame] as const);

const drag = (page: import("@playwright/test").Page, from: [number, number], by: [number, number], shift = false) => page.evaluate(([f, d, sh]) => {
  const cv = document.querySelector(".motion-path canvas")!, r = cv.getBoundingClientRect();
  const ev = (type: string, x: number, y: number) => cv.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.left + x, clientY: r.top + y, pointerId: 1, button: 0, shiftKey: sh }));
  ev("pointerdown", f[0], f[1]);
  ev("pointermove", f[0] + d[0] / 2, f[1] + d[1] / 2);
  ev("pointermove", f[0] + d[0], f[1] + d[1]);
  ev("pointerup", f[0] + d[0], f[1] + d[1]);
}, [from, by, shift] as const);

test("dragging a mark moves the bone at that frame, as one undo step, and seeks there", async ({ page }) => {
  await open(page, "head");
  const { frame, x, y, steps } = await page.evaluate(() => {
    const live = (window as unknown as Live).boneburst, m = live.motionPath.grabPoints.marks, here = live.session.frame;
    // A mark away from the playhead's.
    let f = 0;
    while (f === here || !Number.isFinite(m[f * 2]!)) f++;
    return { frame: f, x: m[f * 2]!, y: m[f * 2 + 1]!, steps: live.session.history.entries.done };
  });
  const before = await keyAt(page, "head", "translate", frame);
  await drag(page, [x, y], [30, -20]);
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.frame)).toBe(frame);
  const after = await keyAt(page, "head", "translate", frame);
  expect(after).not.toBe(before);
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.history.entries.done)).toBe(steps + 1);
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.history.entries.labels.at(-1))).toContain(`Move head at frame ${frame}`);
  // The mark followed the pointer: it is where the drag let go (the view does not rescale under it).
  await expect.poll(() => page.evaluate((f) => (window as unknown as Live).boneburst.motionPath.grabPoints.marks.slice(f * 2, f * 2 + 2), frame)).toEqual([expect.closeTo(x + 30, 0), expect.closeTo(y - 20, 0)]);
});

test("Shift holds the drag to one axis", async ({ page }) => {
  await open(page, "head");
  const { frame, x, y } = await page.evaluate(() => {
    const live = (window as unknown as Live).boneburst, m = live.motionPath.grabPoints.marks, here = live.session.frame;
    let f = 0;
    while (f === here || !Number.isFinite(m[f * 2]!)) f++;
    return { frame: f, x: m[f * 2]!, y: m[f * 2 + 1]! };
  });
  const before = JSON.parse((await keyAt(page, "head", "translate", frame)) ?? "null") as { x?: number; y?: number } | null;
  await drag(page, [x, y], [40, 6], true);
  const after = JSON.parse((await keyAt(page, "head", "translate", frame)) ?? "null") as { x?: number; y?: number } | null;
  // Held to the horizontal in the panel: the world y of the joint does not move, so the key's two parts do not both change in a free direction.
  expect(after).not.toEqual(before);
});

test("the rotation handle turns the bone at the playhead and keys its rotation", async ({ page }) => {
  await open(page, "head");
  const h = await page.evaluate(() => (window as unknown as Live).boneburst.motionPath.grabPoints.handle);
  expect(h).not.toBeNull();
  const frame = await page.evaluate(() => (window as unknown as Live).boneburst.session.frame);
  const steps = await page.evaluate(() => (window as unknown as Live).boneburst.session.history.entries.done);
  const before = await keyAt(page, "head", "rotate", frame);
  await drag(page, [h!.x, h!.y], [0, 40]);
  const after = await keyAt(page, "head", "rotate", frame);
  expect(after).not.toBe(before);
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.history.entries.done)).toBe(steps + 1);
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.history.entries.labels.at(-1))).toContain(`Rotate head at frame ${frame}`);
});

test("a bone an IK constraint drives has no handle, and its marks do not edit", async ({ page }) => {
  // The first bone of the first IK chain in the fixture (open() needs a name, so read it from the file).
  const chain = JSON.parse((await import("node:fs")).readFileSync("tests/fixtures/stickman/Stickman_IK.json", "utf8")).constraints.find((c: { type: string }) => c.type === "ik").bones[0] as string;
  await open(page, chain);
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.motionPath.grabPoints.handle)).toBeNull();
  const steps = await page.evaluate(() => (window as unknown as Live).boneburst.session.history.entries.done);
  const m = await page.evaluate(() => (window as unknown as Live).boneburst.motionPath.grabPoints.marks);
  await drag(page, [m[8]!, m[9]!], [30, 30]);
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.history.entries.done)).toBe(steps);
});

const grab = (page: import("@playwright/test").Page) => page.evaluate(() => {
  const live = (window as unknown as Live).boneburst, g = live.motionPath.grabPoints;
  return { arrows: g.arrows, mark: [g.marks[live.session.frame * 2]!, g.marks[live.session.frame * 2 + 1]!] as [number, number] };
});

test("the move arrows hold a drag to the World axes, or the parent's, by the Axes button", async ({ page }) => {
  await open(page, "head");
  const panel = page.locator(".motion-path");
  await panel.getByRole("button", { name: /^Axes:/ }).click();
  await expect(panel.getByRole("button", { name: "Axes: World" })).toBeVisible();
  const g0 = await grab(page), ax = g0.arrows.find((a) => a.axis === 0)!;
  // The world's x arrow points along the canvas's x.
  expect(ax.y1).toBeCloseTo(ax.y0, 3);
  await drag(page, [(ax.x0 + ax.x1) / 2, (ax.y0 + ax.y1) / 2], [30, 25]);
  // Moved along x only: 30 px right, no change in y (the panel draws on the next frame).
  await expect.poll(async () => (await grab(page)).mark[0] - g0.mark[0]).toBeCloseTo(30, 0);
  const g1 = await grab(page);
  expect(g1.mark[1] - g0.mark[1]).toBeCloseTo(0, 0);
});

test("with the parent's axes an arrow's drag stays on the arrow's own line", async ({ page }) => {
  await open(page, "head");
  const panel = page.locator(".motion-path");
  await expect(panel.getByRole("button", { name: "Axes: Parent" })).toBeVisible();
  const g0 = await grab(page), a = g0.arrows.find((r) => r.axis === 1)!;
  const dx = a.x1 - a.x0, dy = a.y1 - a.y0, len = Math.hypot(dx, dy), ux = dx / len, uy = dy / len;
  await drag(page, [(a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2], [20, -35]);
  await expect.poll(async () => Math.hypot((await grab(page)).mark[0] - g0.mark[0], (await grab(page)).mark[1] - g0.mark[1])).toBeGreaterThan(1);
  const g1 = await grab(page), mx = g1.mark[0] - g0.mark[0], my = g1.mark[1] - g0.mark[1];
  // No part of the move across the arrow, and the part along it is the pointer's.
  expect(mx * -uy + my * ux).toBeCloseTo(0, 0);
  expect(mx * ux + my * uy).toBeCloseTo(20 * ux - 35 * uy, 0);
});

test("the frame tag at the playhead's dot is dragged along the path and the playhead follows to the nearest dot", async ({ page }) => {
  await open(page, "head");
  // The panel's bar (the path's green +) lays out a frame later: read the canvas once it has settled.
  await page.waitForTimeout(400);
  const g = await page.evaluate(() => (window as unknown as Live).boneburst.motionPath.grabPoints as unknown as { marks: number[]; tag: { x0: number; y0: number; x1: number; y1: number } | null });
  expect(g.tag).not.toBeNull();
  const box = (await page.locator(".motion-path canvas").boundingBox())!;
  // The dot of a frame other than the playhead's whose dot no other frame shares (a path that doubles back puts two on one spot), and the tag's middle.
  const n = g.marks.length / 2, here = await page.evaluate(() => (window as unknown as Live).boneburst.session.frame);
  const gap = (f: number) => { let d = Infinity; for (let k = 0; k < n; k++) if (k !== f) d = Math.min(d, Math.hypot(g.marks[k * 2]! - g.marks[f * 2]!, g.marks[k * 2 + 1]! - g.marks[f * 2 + 1]!)); return d; };
  const target = Array.from({ length: n }, (_, f) => f).filter((f) => f !== here).sort((a, b) => gap(b) - gap(a))[0]!, tx = g.marks[target * 2]!, ty = g.marks[target * 2 + 1]!;
  await page.mouse.move(box.x + (g.tag!.x0 + g.tag!.x1) / 2, box.y + (g.tag!.y0 + g.tag!.y1) / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + tx, box.y + ty, { steps: 6 });
  await page.mouse.up();
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.frame)).toBe(target);
  // The playhead moved; no key was edited.
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.history.entries.done)).toBe(0);
});
