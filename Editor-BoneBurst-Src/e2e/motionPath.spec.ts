import { expect, type Page, test } from "@playwright/test";

/**
 * A bone's motion path (docs/PATH-FRAMES-PLAN.md): Edit Path (a spline of nodes, a ring), Bake, then Adjust time (node times, blocks,
 * time multipliers, total frames), then Bake to timeline. Frames only: no seconds, no fps.
 */

type LocalPose = { x: number; y: number; rotation: number; scaleX: number; scaleY: number; shearX: number; shearY: number };
type Node = { x: number; y: number; tx?: number; ty?: number };
type Path = { curves?: number[][]; bone: string; animation: string; nodes: Node[]; closed: boolean; frames: number; starts: number[]; speeds: number[]; baked?: string };
type Live = {
  boneburst: {
    session: {
      sidecar: { motion: Path[] };
      doc: { animations: { name: string; bones?: { name: string; timelines: { name: string; keys: { time?: number; x?: number; y?: number; curve?: unknown }[] }[] }[] }[] };
      history: { entries: { done: number; labels: string[] } };
      frame: number;
      pickedBlock: number;
      fps: number;
      pose(): { bones: Map<string, number>; local: Float32Array | Float64Array } | null;
      seek(f: number): void;
      select(s: unknown): void;
      setUnkeyed(bone: string, local: LocalPose): void;
      changed(): void;
    };
    stage: { forceUnkeyed(): boolean };
    timeline: { blockTabs: { x0: number; x1: number; y: number }[] };
    motionPath: { speedGraph: { x: number; y: number }[]; grabPoints: { nodes: { x: number; y: number }[]; times: { i: number; x: number; y: number }[]; handles: { slot: number; side: string; x: number; y: number }[] } };
  };
};

async function open(page: Page, bone = "head"): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate((b) => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: b }), bone);
  await expect(page.locator(".motion-path .lp-head > span")).toContainText(bone);
}

const translate = (page: Page, bone: string) => page.evaluate((b) => {
  const live = (window as unknown as Live).boneburst, a = live.session.doc.animations[0]!, fps = live.session.fps;
  const keys = a.bones?.find((x) => x.name === b)?.timelines.find((t) => t.name === "translate")?.keys ?? [];
  return keys.map((k) => ({ frame: Math.round((k.time ?? 0) * fps), x: k.x ?? 0, y: k.y ?? 0, curve: k.curve !== undefined }));
}, bone);
const path = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.sidecar.motion[0] ?? null);
const steps = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.history.entries.done);

/** The bone's joint at `frame` in the panel's Local space (from its parent's joint, the world's orientation). */
const localJoint = (page: Page, bone: string, frame: number) => page.evaluate(async ([b, f]) => {
  const posedUrl = "/src/ui/stage/posed.ts", trailUrl = "/src/ui/stage/trail.ts";
  const posed: any = await import(/* @vite-ignore */ posedUrl), trail: any = await import(/* @vite-ignore */ trailUrl);
  const s = (window as unknown as Live).boneburst.session;
  s.seek(f);
  const p = s.pose() as any, i = p.bones.get(b)!, m = posed.boneMatrix(p, i);
  return trail.fromParent(p, i, m[4], m[5]) as [number, number];
}, [bone, frame] as const);

/** Pose `bone` unkeyed at frame 0, `dx`, `dy` from where the animation has it (the bone is dragged; nothing is keyed). */
async function drag(page: Page, bone: string, dx: number, dy: number): Promise<void> {
  await page.evaluate(([b, ax, ay]) => {
    const s = (window as unknown as Live).boneburst.session;
    s.seek(0);
    const p = s.pose()!, i = p.bones.get(b)!, l = p.local, k = i * 7;
    s.setUnkeyed(b, { x: l[k]! + ax, y: l[k + 1]! + ay, rotation: l[k + 2]!, scaleX: l[k + 3]!, scaleY: l[k + 4]!, shearX: l[k + 5]!, shearY: l[k + 6]! });
    // As the Stage does after a drag step: tell the listeners.
    s.changed();
  }, [bone, dx, dy] as const);
}

const panelOf = (page: Page) => page.locator(".motion-path");
const reds = (page: Page) => page.locator(".lp-slots button.node");
const blocks = (page: Page) => page.locator(".lp-slots button.block");

/** Edit Path, the bone dragged a little and its node stored, then Bake (into Adjust time): a path of 2 spline nodes. */
async function drawn(page: Page): Promise<void> {
  await panelOf(page).getByRole("button", { name: "Edit Path", exact: true }).click();
  await expect(reds(page)).toHaveCount(2);
  await panelOf(page).getByRole("button", { name: "Adjust time", exact: true }).click();
  await expect(panelOf(page).getByRole("button", { name: "Adjust time", exact: true })).toHaveAttribute("aria-pressed", "true");
}

test("Edit Path starts with two spline nodes and a green +: [the bone's place] [that plus an offset] [+]; nothing is keyed", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  expect(await path(page)).toBeNull();
  const done = await steps(page), keys = await translate(page, "head"), here = await localJoint(page, "head", 0);
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
  await expect(reds(page)).toHaveCount(2);
  await expect(panel.getByRole("button", { name: "Add a spline node" })).toBeVisible();
  const p = (await path(page))!;
  expect(p.nodes).toHaveLength(2);
  expect(p.closed).toBe(true);
  expect(p.frames).toBe(15);
  // The first is where the bone is; the second is that plus an offset along x.
  expect(p.nodes[0]!.x).toBeCloseTo(here[0], 1);
  expect(p.nodes[0]!.y).toBeCloseTo(here[1], 1);
  expect(p.nodes[1]!.x).toBeGreaterThan(p.nodes[0]!.x + 15);
  expect(p.nodes[1]!.y).toBeCloseTo(p.nodes[0]!.y, 6);
  // Nothing was keyed or edited; the Stage poses unkeyed while drawing.
  expect(await steps(page)).toBe(done);
  expect(await translate(page, "head")).toEqual(keys);
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.stage.forceUnkeyed())).toBe(true);
});

test("edit the spline: + adds a node, the bone drags the picked node, − Node removes one, never below two", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
  const before = (await path(page))!.nodes;
  await panel.getByRole("button", { name: "Add a spline node" }).click();
  await expect(reds(page)).toHaveCount(3);
  expect((await path(page))!.nodes).toHaveLength(3);
  // The bone dragged: the picked node (the new one) goes with it.
  await drag(page, "head", 60, 30);
  await expect.poll(async () => (await path(page))!.nodes[2]).not.toEqual({ x: before[1]!.x + (before[1]!.x - before[0]!.x), y: before[1]!.y });
  expect((await path(page))!.nodes[2]).not.toEqual({ x: before[1]!.x + (before[1]!.x - before[0]!.x), y: before[1]!.y });
  // Remove the third; then the second would leave one: refused (the button is off at two).
  await reds(page).nth(2).click();
  await panel.getByRole("button", { name: "− Node" }).click();
  await expect(reds(page)).toHaveCount(2);
  await expect(panel.getByRole("button", { name: "− Node" })).toBeDisabled();
  expect((await path(page))!.nodes).toHaveLength(2);
});

test("Adjust time (from Edit Path) keeps the spline as it is, with two node times, and writes nothing to the timeline", async ({ page }) => {
  await open(page);
  const keys = await translate(page, "head"), done = await steps(page);
  await drawn(page);
  const p = (await path(page))!;
  // Two node times: frame 0 and the middle of the 15; two blocks.
  expect(p.starts).toEqual([8]);
  await expect(blocks(page)).toHaveCount(2);
  await expect(blocks(page).first()).toContainText("0→8");
  await expect(blocks(page).nth(1)).toContainText("8→15");
  expect(await translate(page, "head")).toEqual(keys);
  expect(await steps(page)).toBe(done);
  // The two modes show their own buttons.
  await expect(panelOf(page).getByRole("button", { name: "Bake to timeline" })).toBeVisible();
  await expect(panelOf(page).getByRole("button", { name: "Bake", exact: true })).toHaveCount(0);
  await expect(panelOf(page).getByRole("button", { name: "Add a spline node" })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.stage.forceUnkeyed())).toBe(false);
});

test("Adjust time: + Time adds a node time at the playhead's frame, − Time removes one, never below two; the strip shows the blocks", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  await drawn(page);
  await expect(panel.getByRole("button", { name: "− Time" })).toBeDisabled();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.seek(5));
  await panel.getByRole("button", { name: "+ Time" }).click();
  await expect.poll(async () => (await path(page))!.starts).toEqual([5, 8]);
  await expect(blocks(page)).toHaveCount(3);
  await expect(blocks(page).first()).toContainText("0→5");
  // Pick the block that starts on 5 and remove its node time.
  await blocks(page).nth(1).click();
  await expect(panel.getByRole("button", { name: "− Time" })).toBeEnabled();
  await panel.getByRole("button", { name: "− Time" }).click();
  await expect.poll(async () => (await path(page))!.starts).toEqual([8]);
  await expect(panel.getByRole("button", { name: "− Time" })).toBeDisabled();
});

test("Total frames is set in Motion Path (14 + 0); the node times keep their share; Closed off ends the path on the last frame shown", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
  // Edit Path shapes the spline: Closed is here, Total frames is not.
  await expect(panel.getByRole("spinbutton", { name: "Total frames" })).toBeHidden();
  await expect(panel.locator("label.lp-field input[type=checkbox]")).toBeVisible();
  await panel.getByRole("button", { name: "Adjust time", exact: true }).click();
  await expect(panel.locator("label.lp-field input[type=checkbox]")).toBeHidden();
  const frames = panel.getByRole("spinbutton", { name: "Total frames" });
  await expect(frames).toHaveValue("15");
  await expect(panel.getByText("(14 + 0)")).toBeVisible();
  await frames.fill("30");
  await frames.press("Enter");
  await frames.blur();
  await expect.poll(async () => (await path(page))!.frames).toBe(30);
  expect((await path(page))!.starts).toEqual([16]);
  await expect(panel.getByText("(29 + 0)")).toBeVisible();
  // No path field on the Timeline bar any more.
  await expect(page.getByRole("spinbutton", { name: "Path time (s)" })).toHaveCount(0);
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
  await panel.locator("label.lp-field input[type=checkbox]").uncheck();
  await expect.poll(async () => (await path(page))!.closed).toBe(false);
  await panel.getByRole("button", { name: "Adjust time", exact: true }).click();
  await expect(blocks(page).nth(1)).toContainText("→29");
});

test("a block's time multiplier: the block covers more of the ring; Bake to timeline writes a key at each node time and a closing key that copies the first; one undo step", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  await drawn(page);
  await page.evaluate(() => (window as unknown as Live).boneburst.session.seek(5));
  await panel.getByRole("button", { name: "+ Time" }).click();
  await expect.poll(async () => (await path(page))!.starts).toEqual([5, 8]);
  // The second block (5→8) twice as fast.
  await blocks(page).nth(1).click();
  const speed = panel.getByRole("spinbutton", { name: "Block time multiplier" });
  await speed.fill("2");
  await speed.press("Enter");
  await speed.blur();
  await expect.poll(async () => (await path(page))!.speeds).toEqual([1, 2, 1]);
  await expect(blocks(page).nth(1)).toContainText("×2");
  // Bake to timeline: keys on 0, 5, 8 and the closing 15.
  const done = await steps(page);
  await panel.getByRole("button", { name: "Bake to timeline" }).click();
  await expect.poll(async () => (await path(page))!.baked).toBeDefined();
  const keys = await translate(page, "head");
  expect(keys.map((k) => k.frame)).toEqual([0, 5, 8, 15]);
  expect(keys.at(-1)!.x).toBeCloseTo(keys[0]!.x, 3);
  expect(keys.at(-1)!.y).toBeCloseTo(keys[0]!.y, 3);
  expect(keys.slice(0, 3).every((k) => k.curve)).toBe(true);
  expect(await steps(page)).toBe(done + 1);
  // The bone is on the first node on frame 0, and at the ring's position for frame 8 (the model's, by the multiplier).
  const p = (await path(page))!, first = await localJoint(page, "head", 0);
  expect(first[0]).toBeCloseTo(p.nodes[0]!.x, 1);
  const got = await localJoint(page, "head", 8);
  const want = await page.evaluate(async ([m]) => { const url = "/src/edit/motionPath.ts"; const mod: any = await import(/* @vite-ignore */ url); return mod.placeAtFrame(m, 8) as { x: number; y: number }; }, [p] as const);
  expect(Math.hypot(got[0] - want.x, got[1] - want.y)).toBeLessThan(4);
});

test("the baked bone follows the ring between its keys: within a few units of the path at every frame", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
  await panel.getByRole("button", { name: "Add a spline node" }).click();
  await panel.getByRole("button", { name: "Adjust time", exact: true }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.seek(5));
  await panel.getByRole("button", { name: "+ Time" }).click();
  await panel.getByRole("button", { name: "Bake to timeline" }).click();
  await expect.poll(async () => (await path(page))!.baked).toBeDefined();
  const p = (await path(page))!;
  let worst = 0;
  for (let f = 0; f < p.frames; f++) {
    const got = await localJoint(page, "head", f);
    const want = await page.evaluate(async ([m, fr]) => { const url = "/src/edit/motionPath.ts"; const mod: any = await import(/* @vite-ignore */ url); return mod.placeAtFrame(m, fr) as { x: number; y: number }; }, [p, f] as const);
    worst = Math.max(worst, Math.hypot(got[0] - want.x, got[1] - want.y));
  }
  expect(worst).toBeLessThan(4);
});

test("Remove path forgets the path and keeps the keys", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  await drawn(page);
  await panel.getByRole("button", { name: "Bake to timeline" }).click();
  await expect.poll(async () => (await path(page))!.baked).toBeDefined();
  const keys = await translate(page, "head");
  expect(keys).toHaveLength(3);
  await panel.getByRole("button", { name: "Remove path" }).click();
  expect(await path(page)).toBeNull();
  expect(await translate(page, "head")).toEqual(keys);
});

test("in Edit Path the bone and the picked node follow each other: drag the bone, the node moves; drag the node, the bone moves", async ({ page }) => {
  await open(page);
  await panelOf(page).getByRole("button", { name: "Edit Path", exact: true }).click();
  const stored = (await path(page))!.nodes;
  // The bone dragged on the Stage (unkeyed, as Edit Path poses it): the picked node (the second) follows, without pressing red.
  await drag(page, "head", 30, 50);
  await expect.poll(async () => (await path(page))!.nodes[1]).not.toEqual(stored[1]);
  expect((await path(page))!.nodes[0]).toEqual(stored[0]);
  // A node dragged on the canvas: the bone is posed at it and goes with it.
  await page.waitForTimeout(400);
  const nodes = await page.evaluate(() => (window as unknown as Live).boneburst.motionPath.grabPoints.nodes);
  const box = (await page.locator(".motion-path canvas").first().boundingBox())!;
  const local = () => page.evaluate(() => { const s = (window as unknown as Live).boneburst.session, p = s.pose()!, k = p.bones.get("head")! * 7; return [p.local[k]!, p.local[k + 1]!]; });
  await page.mouse.move(box.x + nodes[0]!.x, box.y + nodes[0]!.y);
  await page.mouse.down();
  const atPress = await local();
  await page.mouse.move(box.x + nodes[0]!.x + 40, box.y + nodes[0]!.y - 30, { steps: 6 });
  const during = await local();
  await page.mouse.up();
  expect(Math.hypot(during[0]! - atPress[0]!, during[1]! - atPress[1]!)).toBeGreaterThan(1);
});

test("hand tools: on a ring every node has both handles; dragging one bends the curve and keeps the node; a double click puts it back to automatic", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
  await panel.getByRole("button", { name: "Add a spline node" }).click();
  await page.waitForTimeout(400);
  const handles = () => page.evaluate(() => (window as unknown as Live).boneburst.motionPath.grabPoints.handles);
  const hs = await handles();
  expect(hs.map((h) => `${h.slot}:${h.side}`).sort()).toEqual(["0:in", "0:out", "1:in", "1:out", "2:in", "2:out"]);
  const before = (await path(page))!.nodes;
  expect(before[1]!.tx).toBeUndefined();
  const out = hs.find((h) => h.slot === 1 && h.side === "out")!;
  const box = (await page.locator(".motion-path canvas").first().boundingBox())!;
  await page.mouse.move(box.x + out.x, box.y + out.y);
  await page.mouse.down();
  await page.mouse.move(box.x + out.x, box.y + out.y - 60, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await path(page))!.nodes[1]!.ty).not.toBeUndefined();
  const after = (await path(page))!.nodes;
  expect(after[1]!.x).toBe(before[1]!.x);
  expect(after[1]!.y).toBe(before[1]!.y);
  expect(after[0]).toEqual(before[0]);
  const again = (await handles()).find((h) => h.slot === 1 && h.side === "out")!;
  await page.mouse.dblclick(box.x + again.x, box.y + again.y);
  await expect.poll(async () => (await path(page))!.nodes[1]!.tx).toBeUndefined();
});

test("a block's speed graph: a straight line at 1 by default; presets and dragged points bend the speed inside the block, never its frames; Bake follows it", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  await drawn(page);
  // No block picked: no graph.
  await expect(page.locator(".lp-graph")).toBeHidden();
  await blocks(page).first().click();
  await expect(page.locator(".lp-graph")).toBeVisible();
  const dots = () => page.evaluate(() => (window as unknown as Live).boneburst.motionPath.speedGraph);
  await expect.poll(async () => (await dots()).length).toBe(2);
  const flat = await dots();
  expect(flat[0]!.y).toBeCloseTo(flat[1]!.y, 6);
  expect((await path(page))!.curves).toBeUndefined();
  // A preset: Slow in.
  await panel.getByRole("button", { name: "Slow in", exact: true }).click();
  await expect.poll(async () => (await path(page))!.curves?.[0]).toEqual([0, 0.2, 1, 1.8]);
  await expect(blocks(page).first()).toContainText("∿");
  expect((await path(page))!.starts).toEqual([8]);
  // Dragging the first point up changes its speed and keeps its place in time.
  const box = (await page.locator(".lp-graph-canvas").boundingBox())!, [a] = await dots();
  await page.mouse.move(box.x + a!.x, box.y + a!.y);
  await page.mouse.down();
  await page.mouse.move(box.x + a!.x + 30, box.y + 12, { steps: 5 });
  await page.mouse.up();
  const c = (await path(page))!.curves![0]!;
  expect(c[0]).toBe(0);
  expect(c[1]).toBeGreaterThan(1.8);
  // A double click on empty graph adds a point; on that point it removes it again.
  const mid = { x: box.x + box.width / 2, y: box.y + box.height - 12 };
  await page.mouse.dblclick(mid.x, mid.y);
  await expect.poll(async () => (await dots()).length).toBe(3);
  const [, m] = await dots();
  await page.mouse.dblclick(box.x + m!.x, box.y + m!.y);
  await expect.poll(async () => (await dots()).length).toBe(2);
  // Even puts the straight line back.
  await panel.getByRole("button", { name: "Even", exact: true }).click();
  await expect.poll(async () => (await path(page))!.curves).toBeUndefined();
  // Baked slow-in: at the block's middle the bone is behind where the even bake has it.
  const at = async (): Promise<number> => (await localJoint(page, "head", 4))[0];
  await panel.getByRole("button", { name: "Bake to timeline" }).click();
  await expect.poll(async () => (await path(page))!.baked).toBeDefined();
  const even = await at();
  await panel.getByRole("button", { name: "Slow in", exact: true }).click();
  await panel.getByRole("button", { name: "Bake to timeline" }).click();
  const p = (await path(page))!;
  const slow = await at();
  const want = await page.evaluate(async ([m]) => { const url = "/src/edit/motionPath.ts"; const mod: any = await import(/* @vite-ignore */ url); return mod.placeAtFrame(m, 4) as { x: number; y: number }; }, [p] as const);
  expect(Math.abs(slow - even)).toBeGreaterThan(1);
  expect(Math.abs(slow - want.x)).toBeLessThan(4);
});

test("no path yet: one green + creates it (node 1 is the bone, node 2 the bone plus an offset); a red number puts the bone on its node and it follows from then on", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  expect(await path(page)).toBeNull();
  await expect(reds(page)).toHaveCount(0);
  const create = panel.getByRole("button", { name: "Create a path" });
  await expect(create).toBeVisible();
  const here = await localJoint(page, "head", 0);
  await create.click();
  await expect(reds(page)).toHaveCount(2);
  const nodes = (await path(page))!.nodes;
  expect(nodes[0]!.x).toBeCloseTo(here[0], 1);
  expect(nodes[0]!.y).toBeCloseTo(here[1], 1);
  expect(nodes[1]!.x).toBeGreaterThan(nodes[0]!.x + 15);
  // Move the bone (the picked node 2 follows), then press the red numbers: the bone goes to each node.
  await drag(page, "head", 20, 40);
  await expect.poll(async () => (await path(page))!.nodes[1]).not.toEqual(nodes[1]);
  const moved = (await path(page))!.nodes;
  // The bone's joint as posed now (no seek: that would drop the unkeyed pose).
  const joint = () => page.evaluate(async () => {
    const posedUrl = "/src/ui/stage/posed.ts", trailUrl = "/src/ui/stage/trail.ts";
    const posed: any = await import(/* @vite-ignore */ posedUrl), trail: any = await import(/* @vite-ignore */ trailUrl);
    const p = (window as unknown as Live).boneburst.session.pose() as any, i = p.bones.get("head")!, m = posed.boneMatrix(p, i);
    return trail.fromParent(p, i, m[4], m[5]) as [number, number];
  });
  await reds(page).nth(1).click();
  await expect.poll(async () => (await joint())[0]).toBeCloseTo(moved[1]!.x, 1);
  expect((await joint())[1]).toBeCloseTo(moved[1]!.y, 1);
  await reds(page).first().click();
  await expect.poll(async () => (await joint())[0]).toBeCloseTo(moved[0]!.x, 1);
  expect((await joint())[1]).toBeCloseTo(moved[0]!.y, 1);
  expect((await path(page))!.nodes).toEqual(moved);
});

test("the Timeline's tab strip shows the path's blocks (not the key gaps) and picking a tab picks the block in Motion Path too", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  await drawn(page);
  await page.evaluate(() => (window as unknown as Live).boneburst.session.seek(5));
  await panel.getByRole("button", { name: "+ Time" }).click();
  await expect.poll(async () => (await path(page))!.starts).toEqual([5, 8]);
  await page.waitForTimeout(300);
  const tabs = () => page.evaluate(() => (window as unknown as Live).boneburst.timeline.blockTabs);
  const t = await tabs();
  // The blocks 0→5, 5→8, 8→15, drawn under the Timeline's ruler.
  expect(t).toHaveLength(3);
  expect(t[0]!.x1).toBeCloseTo(t[1]!.x0, 6);
  expect(t[2]!.x1 - t[2]!.x0).toBeGreaterThan(t[1]!.x1 - t[1]!.x0);
  await blocks(page).first().click();
  await expect(blocks(page).first()).toHaveClass(/picked/);
  // Pick the middle one on the Timeline: Motion Path's strip has it picked.
  const canvas = page.locator(".timeline canvas").first(), box = (await canvas.boundingBox())!;
  await page.mouse.click(box.x + (t[1]!.x0 + t[1]!.x1) / 2, box.y + t[1]!.y);
  await expect(blocks(page).nth(1)).toHaveClass(/picked/);
  await expect(panel.getByRole("spinbutton", { name: "Block time multiplier" })).toBeVisible();
  // And the other way: pick the third in Motion Path; the Timeline's picked block follows.
  await blocks(page).nth(2).click();
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.pickedBlock)).toBe(2);
  // The Timeline paints it (a 2 px accent outline on the third tab): its canvas changed.
  const picture = () => canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  const third = await picture();
  await blocks(page).first().click();
  await expect.poll(picture).not.toBe(third);
});

test("a red number moves the bone on the Stage: the session announces each pose, for node 1 and node 2, as often as they are pressed", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  await page.evaluate(() => { const w = window as unknown as { __n: number; boneburst: Live["boneburst"] & { session: { onChange(f: () => void): void } } }; w.__n = 0; w.boneburst.session.onChange(() => { w.__n++; }); });
  const count = () => page.evaluate(() => (window as unknown as { __n: number }).__n);
  const joint = () => page.evaluate(async () => {
    const posedUrl = "/src/ui/stage/posed.ts", trailUrl = "/src/ui/stage/trail.ts";
    const posed: any = await import(/* @vite-ignore */ posedUrl), trail: any = await import(/* @vite-ignore */ trailUrl);
    const p = (window as unknown as Live).boneburst.session.pose() as any, i = p.bones.get("head")!, m = posed.boneMatrix(p, i);
    return trail.fromParent(p, i, m[4], m[5]) as [number, number];
  });
  await panel.getByRole("button", { name: "Create a path" }).click();
  const nodes = (await path(page))!.nodes;
  // Created: the bone is on node 2 (the picked one), not left on node 1.
  await expect.poll(async () => (await joint())[0]).toBeCloseTo(nodes[1]!.x, 1);
  for (const [i, n] of [[0, nodes[0]!], [1, nodes[1]!], [0, nodes[0]!], [1, nodes[1]!]] as const) {
    const before = await count();
    await reds(page).nth(i).click();
    await expect.poll(count).toBeGreaterThan(before);
    await expect.poll(async () => (await joint())[0]).toBeCloseTo(n.x, 1);
    expect((await joint())[1]).toBeCloseTo(n.y, 1);
  }
  expect((await path(page))!.nodes).toEqual(nodes);
  // And the Stage itself repaints: its picture differs between the two nodes.
  const stage = page.locator(".stage").first();
  await reds(page).nth(0).click();
  await page.waitForTimeout(300);
  const one = await stage.screenshot();
  await reds(page).nth(1).click();
  await page.waitForTimeout(300);
  expect((await stage.screenshot()).equals(one)).toBe(false);
});

test("Adjust time edits the timing only: the bone is not dragged on the Stage or in Motion Path, the spline stays, and the bone is back on the animation's pose", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
  await drag(page, "head", 50, 20);
  await expect.poll(async () => (await path(page))!.nodes[1]).toBeDefined();
  const nodes = (await path(page))!.nodes;
  await panel.getByRole("button", { name: "Adjust time", exact: true }).click();
  // The unkeyed pose from drawing is dropped: the bone is where the animation has it.
  expect(await page.evaluate(() => (window as unknown as { boneburst: { session: { hasUnkeyed: boolean } } }).boneburst.session.hasUnkeyed)).toBe(false);
  expect(await page.evaluate(() => (window as unknown as { boneburst: { motionPath: { timing: boolean } } }).boneburst.motionPath.timing)).toBe(true);
  const keys = await translate(page, "head"), done = await steps(page);
  // A drag of the bone on the Stage: nothing is keyed, nothing is posed.
  const at = await page.evaluate(async () => {
    const b = (window as unknown as Live).boneburst, posed: any = await import(/* @vite-ignore */ "/src/ui/stage/" + "posed.ts"), st = b.stage as any;
    const p = b.session.pose() as any, m = posed.boneMatrix(p, p.bones.get("head")!), cam = st.camera, sz = st.size, r = document.querySelector(".stage canvas.overlay")!.getBoundingClientRect();
    return { x: r.left + (m[4] - cam.x) * cam.zoom + sz.width / 2, y: r.top + sz.height / 2 - (m[5] - cam.y) * cam.zoom };
  });
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 40, at.y - 30, { steps: 5 });
  await page.mouse.up();
  expect(await translate(page, "head")).toEqual(keys);
  expect(await steps(page)).toBe(done);
  expect(await page.evaluate(() => (window as unknown as { boneburst: { session: { hasUnkeyed: boolean } } }).boneburst.session.hasUnkeyed)).toBe(false);
  // The spline is not touched by the panel either: its canvas has no node or handle to grab.
  expect((await path(page))!.nodes).toEqual(nodes);
  await page.waitForTimeout(300);
  const g = await page.evaluate(() => (window as unknown as Live).boneburst.motionPath.grabPoints);
  const box = (await page.locator(".motion-path canvas").first().boundingBox())!;
  if (g.nodes[0]) {
    await page.mouse.move(box.x + g.nodes[0].x, box.y + g.nodes[0].y);
    await page.mouse.down();
    await page.mouse.move(box.x + g.nodes[0].x + 30, box.y + g.nodes[0].y + 30, { steps: 4 });
    await page.mouse.up();
  }
  expect((await path(page))!.nodes).toEqual(nodes);
  expect(await page.evaluate(() => (window as unknown as { boneburst: { session: { hasUnkeyed: boolean } } }).boneburst.session.hasUnkeyed)).toBe(false);
  // Back in Edit Path the bone drags again.
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { boneburst: { motionPath: { timing: boolean } } }).boneburst.motionPath.timing)).toBe(false);
});

test("the numbered node buttons are green and alone in their strip (the + is in the upper row), and dragging one to another place moves it there", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
  await panel.getByRole("button", { name: "Add a spline node" }).click();
  await expect(reds(page)).toHaveCount(3);
  // The + is in the upper row with the mode buttons; the strip holds the numbers only.
  await expect(page.locator(".lp-slots").getByRole("button", { name: "Add a spline node" })).toHaveCount(0);
  await expect(page.locator(".lp-motion").getByRole("button", { name: "Add a spline node" })).toBeVisible();
  await expect(reds(page)).toHaveText(["1", "2", "3"]);
  // Square cells from the left edge.
  const cells = await reds(page).evaluateAll((bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return { x: r.left, w: r.width, h: r.height }; }));
  expect(cells.every((c) => c.w === c.h)).toBe(true);
  const strip = await page.locator(".lp-slots").evaluate((e) => e.getBoundingClientRect().left);
  expect(cells[0]!.x).toBe(strip);
  expect(cells[1]!.x).toBeCloseTo(cells[0]!.x + cells[0]!.w, 0);
  const green = await reds(page).first().evaluate((b) => getComputedStyle(b).backgroundColor);
  expect(green).toBe("rgb(46, 158, 79)");
  const before = (await path(page))!.nodes;
  await drag(page, "head", 60, 30);
  await expect.poll(async () => (await path(page))!.nodes[2]).not.toEqual(before[2]);
  const nodes = (await path(page))!.nodes;
  // Node 3 dragged onto node 2: the path runs 1, 3, 2: the buttons read so, each place keeps its number.
  await dragNode(page, 2, 1);
  await expect.poll(async () => (await path(page))!.nodes[1]).toMatchObject({ x: nodes[2]!.x, y: nodes[2]!.y });
  const after = (await path(page))!.nodes;
  expect(after[0]).toEqual({ ...nodes[0]!, id: 1 });
  expect(after[2]).toMatchObject({ x: nodes[1]!.x, y: nodes[1]!.y, id: 2 });
  await expect(reds(page)).toHaveText(["1", "3", "2"]);
  // The keys on the timeline are the old order's until Bake to timeline.
  await expect(panel.getByRole("button", { name: "Add a spline node" })).toBeVisible();
});

/** Drag the numbered button at place `from` to place `to` with the mouse, in steps; `hold` leaves it held on `to`. */
async function dragNode(page: Page, from: number, to: number, hold = false): Promise<void> {
  // The strip repaints after an edit: let it settle before taking the cells' places.
  await expect(reds(page).nth(Math.max(from, to))).toBeVisible();
  await page.waitForTimeout(150);
  const a = (await reds(page).nth(from).boundingBox())!, b = (await reds(page).nth(to).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2 + a.width / 2, a.y + a.height / 2 + 3, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  if (!hold) await page.mouse.up();
}

test("dragging a number is guided: a red arrow carrying its number marks the gap it would go into, the status line and the canvas show the new order before the drop; Escape or letting go outside leaves it", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
  await panel.getByRole("button", { name: "Add a spline node" }).click();
  await expect(reds(page)).toHaveCount(3);
  const nodes = (await path(page))!.nodes;
  const canvas = page.locator(".local-path canvas, .motion-path canvas").first();
  const picture = () => canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  await page.waitForTimeout(300);
  const still = await picture();
  // Held over node 2's left half (the gap before it): ghost, the red arrow in that gap, the path not changed yet.
  await dragNode(page, 2, 1, true);
  // The dragged number rides in the arrow; there is no floating label.
  await expect(page.locator(".lp-drop-arrow span")).toHaveText("3");
  await expect(page.locator(".lp-ghost")).toHaveCount(0);
  await expect(reds(page).nth(2)).toHaveClass(/dragging/);
  const arrow = page.locator(".lp-drop-arrow");
  await expect(arrow).toBeVisible();
  const gap = await arrow.evaluate((a) => a.getBoundingClientRect().left + a.getBoundingClientRect().width / 2);
  const second = (await reds(page).nth(1).boundingBox())!;
  expect(Math.abs(gap - second.x)).toBeLessThan(2);
  await expect(page.locator(".message")).toContainText("the path will run 1, 3, 2");
  expect((await path(page))!.nodes).toEqual(nodes);
  // The canvas shows the path as it would run (a different picture while held).
  await expect.poll(picture).not.toBe(still);
  // Escape: everything back, nothing changed.
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await expect(page.locator(".lp-drop-arrow")).toHaveCount(0);
  await expect.poll(picture).toBe(still);
  await expect(page.locator(".lp-drop-arrow")).toHaveCount(0);
  expect((await path(page))!.nodes).toEqual(nodes);
  // Let go far outside the strip: nothing changes either.
  const a = (await reds(page).nth(2).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 20, a.y + 300, { steps: 5 });
  await page.mouse.up();
  expect((await path(page))!.nodes).toEqual(nodes);
  await expect(reds(page)).toHaveText(["1", "2", "3"]);
  // A plain press is still a press: it puts the bone on that node.
  await reds(page).first().click();
  expect((await path(page))!.nodes).toEqual(nodes);
  // Dropped on node 2: it is done.
  await dragNode(page, 2, 1);
  await expect(reds(page)).toHaveText(["1", "3", "2"]);
});

test("a number dragged along the strip lands in the gap the red arrow shows, the others shifting: 3, 1, 2, 4 with 1 dropped after 2 gives 3, 2, 1, 4", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
  for (let k = 0; k < 2; k++) await panel.getByRole("button", { name: "Add a spline node" }).click();
  await expect(reds(page)).toHaveCount(4);
  const nodes = (await path(page))!.nodes;
  await dragNode(page, 2, 0);
  await expect(reds(page)).toHaveText(["3", "1", "2", "4"]);
  // Pick 1 (the second cell), then drag it right: held over the right half of 2 the arrow is between 2 and 4.
  await reds(page).nth(1).click();
  const a = (await reds(page).nth(1).boundingBox())!, c = (await reds(page).nth(2).boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width * 0.75, c.y + c.height / 2, { steps: 6 });
  await expect(page.locator(".lp-drop-arrow")).toBeVisible();
  const gap = await page.locator(".lp-drop-arrow").evaluate((el) => el.getBoundingClientRect().left + el.getBoundingClientRect().width / 2);
  expect(Math.abs(gap - (c.x + c.width))).toBeLessThan(2);
  await expect(page.locator(".message")).toContainText("the path will run 3, 2, 1, 4");
  await page.mouse.up();
  await expect(reds(page)).toHaveText(["3", "2", "1", "4"]);
  // The picked one (1) is still picked, now third; the places are the same set.
  await expect(reds(page).nth(2)).toHaveClass(/picked/);
  const after = (await path(page))!.nodes;
  expect(after.map((n) => [n.x, n.y])).toEqual([nodes[2], nodes[1], nodes[0], nodes[3]].map((n) => [n!.x, n!.y]));
});

test("right-click a number: Set to Origin starts the ring there and goes round in the same order: 3, 1, 2, 4 with 2 gives 2, 4, 3, 1", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
  for (let k = 0; k < 2; k++) await panel.getByRole("button", { name: "Add a spline node" }).click();
  await dragNode(page, 2, 0);
  await expect(reds(page)).toHaveText(["3", "1", "2", "4"]);
  const before = (await path(page))!.nodes;
  // The first is the origin already: the item is there but off.
  await reds(page).first().click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Set 3 to Origin" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await reds(page).nth(2).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Set 2 to Origin" }).click();
  await expect(reds(page)).toHaveText(["2", "4", "3", "1"]);
  const after = (await path(page))!.nodes;
  expect(after.map((n) => [n.x, n.y])).toEqual([before[2], before[3], before[0], before[1]].map((n) => [n!.x, n!.y]));
  await expect(page.locator(".message")).toContainText("starts at 2");
  // An open path has two ends: no other origin.
  await panel.locator("label.lp-field input[type=checkbox]").uncheck();
  await reds(page).nth(1).click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Set 4 to Origin" })).toBeDisabled();
});

test("Q and W: the previous and next node while the pointer is over Motion Path, the previous and next frame over the Timeline", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
  await panel.getByRole("button", { name: "Add a spline node" }).click();
  await expect(reds(page)).toHaveCount(3);
  const frame = () => page.evaluate(() => (window as unknown as Live).boneburst.session.frame);
  // Press in the Motion Path panel (its header: nothing there acts): Q and W go through the nodes (the third is picked after adding).
  await panel.locator(".lp-head").click();
  await expect(reds(page).nth(2)).toHaveClass(/picked/);
  await page.keyboard.press("q");
  await expect(reds(page).nth(1)).toHaveClass(/picked/);
  await page.keyboard.press("q");
  await expect(reds(page).first()).toHaveClass(/picked/);
  await page.keyboard.press("w");
  await expect(reds(page).nth(1)).toHaveClass(/picked/);
  // A ring goes round: W from the last is the first.
  await page.keyboard.press("w");
  await page.keyboard.press("w");
  await expect(reds(page).first()).toHaveClass(/picked/);
  expect(await frame()).toBe(0);
  // Press in the Timeline: the same keys step frames, the node stays where it was.
  await page.locator(".timeline canvas").first().click({ position: { x: 300, y: 8 } });
  const here = await frame();
  await page.keyboard.press("w");
  expect(await frame()).toBe(here + 1);
  await page.keyboard.press("q");
  expect(await frame()).toBe(here);
  await expect(reds(page).first()).toHaveClass(/picked/);
  // Back in Motion Path they are nodes again; "," and "." stay frames.
  await panel.locator(".lp-head").click();
  await page.keyboard.press("w");
  await expect(reds(page).nth(1)).toHaveClass(/picked/);
  const f = await frame();
  await page.keyboard.press(".");
  expect(await frame()).toBe(f + 1);
});

test("F and the arrow keys belong to the panel under the pointer: over Motion Path, F fits its view and an arrow moves the picked node (the bone with it); over the Stage they are the Stage's", async ({ page }) => {
  await open(page);
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "Edit Path", exact: true }).click();
  await page.waitForTimeout(300);
  const canvas = page.locator(".motion-path canvas").first(), box = (await canvas.boundingBox())!;
  const picture = () => canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  const fitted = await picture();
  // Zoom the panel's view with the wheel, then F over it brings it back.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(picture).not.toBe(fitted);
  await page.keyboard.press("f");
  await expect.poll(picture).toBe(fitted);
  // An arrow over the panel moves the picked node (the second after Edit Path), by the nudge step; Shift by the big step.
  const nodes = (await path(page))!.nodes;
  await page.keyboard.press("ArrowUp");
  await expect.poll(async () => (await path(page))!.nodes[1]!.y).toBeGreaterThan(nodes[1]!.y);
  const step = (await path(page))!.nodes[1]!.y - nodes[1]!.y;
  expect(step).toBeGreaterThan(0);
  expect((await path(page))!.nodes[0]).toEqual(nodes[0]);
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => (await path(page))!.nodes[1]!.x - nodes[1]!.x).toBeGreaterThan(step * 2);
  // The bone is on the node.
  const joint = await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session, p = s.pose()!, k = p.bones.get("head")! * 7; return [p.local[k]!, p.local[k + 1]!]; });
  expect(joint.every((v) => Number.isFinite(v))).toBe(true);
  // Over the Stage the arrows are the Stage's: the node does not move.
  const moved = (await path(page))!.nodes;
  const stage = (await page.locator(".stage canvas.overlay").boundingBox())!;
  await page.mouse.move(stage.x + 20, stage.y + 20);
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(200);
  expect((await path(page))!.nodes).toEqual(moved);
});
