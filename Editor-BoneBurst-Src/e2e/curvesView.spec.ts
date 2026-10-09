import { expect, type Page, test } from "@playwright/test";

/** FramePath's Curves sub-panel (docs/CURVES-PANEL-PLAN.md, step 2): the playhead's span as Spine's Curves view, its kind and its handles. */

type Key = { time?: number; x?: number; y?: number; curve?: unknown };
type Live = { boneburst: { session: { select(s: unknown): void; seek(f: number): void; fps: number; history: { undo(): void; entries: { done: number } }; changed(): void; doc: { animations: { bones?: { name: string; timelines: { name: string; keys: Key[] }[] }[] }[] } }; motionPath: { curveHandles: readonly { side: "out" | "in"; x: number; y: number }[]; grabPoints: { marks: number[] } } } };

const keys = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.doc.animations[0]!.bones!.find((b) => b.name === "hips")!.timelines.find((t) => t.name === "translate")!.keys.map((k) => ({ t: k.time ?? 0, x: k.x ?? 0, y: k.y ?? 0, curve: k.curve ?? null })));
const handles = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.motionPath.curveHandles);
const steps = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.history.entries.done);

async function open(page: Page): Promise<number[]> {
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^FramePath$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  const fps = await page.evaluate(() => (window as unknown as Live).boneburst.session.fps);
  return (await keys(page)).map((k) => Math.round(k.t * fps));
}

test("the Curves view shows the playhead's span; Bezier, Stepped and Linear set its kind, one undo step each", async ({ page }) => {
  const frames = await open(page);
  await page.evaluate((f) => (window as unknown as Live).boneburst.session.seek(f), frames[1]!);
  const curves = page.locator(".panel.motion-path .lp-curves");
  await expect(curves).toBeVisible();
  const kind = (k: string) => curves.getByRole("button", { name: new RegExp(`^${k}:`) });
  await kind("Stepped").click();
  await expect(kind("Stepped")).toHaveAttribute("aria-pressed", "true");
  expect((await keys(page))[1]!.curve).toBe("stepped");
  await expect.poll(async () => (await handles(page)).length).toBe(0);
  await kind("Linear").click();
  expect((await keys(page))[1]!.curve).toBeNull();
  await expect.poll(async () => (await handles(page)).length).toBe(2);
  const done = await steps(page);
  await kind("Bezier").click();
  await expect(kind("Bezier")).toHaveAttribute("aria-pressed", "true");
  expect(Array.isArray((await keys(page))[1]!.curve)).toBe(true);
  expect(await steps(page)).toBe(done + 1);
});

test("dragging a handle eases the span, one undo step, the keys' places kept; on a Linked key its other leg follows", async ({ page }) => {
  const frames = await open(page);
  await page.evaluate((f) => (window as unknown as Live).boneburst.session.seek(f), frames[1]!);
  const before = await keys(page), done = await steps(page);
  const speedIn = page.locator(".panel.motion-path").getByRole("spinbutton", { name: "Speed in" }), speedOut = page.locator(".panel.motion-path").getByRole("spinbutton", { name: "Speed out" });
  await expect(page.locator(".panel.motion-path").getByRole("button", { name: "Linked", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () => (await handles(page)).length).toBe(2);
  const out = (await handles(page)).find((h) => h.side === "out")!, box = (await page.locator(".panel.motion-path .lp-curves-canvas").boundingBox())!;
  // Up: key 2 leaves faster.
  await page.mouse.move(box.x + out.x, box.y + out.y);
  await page.mouse.down();
  await page.mouse.move(box.x + out.x, box.y + out.y - 25, { steps: 5 });
  await page.mouse.up();
  const after = await keys(page);
  expect(after.map((k) => [k.t, k.x, k.y])).toEqual(before.map((k) => [k.t, k.x, k.y]));
  expect(Array.isArray(after[1]!.curve)).toBe(true);
  expect(await steps(page)).toBe(done + 1);
  await expect.poll(async () => Number(await speedOut.inputValue())).toBeGreaterThan(0.2);
  // Linked: the speed arriving at key 2 took the same value.
  expect(Number(await speedIn.inputValue())).toBeCloseTo(Number(await speedOut.inputValue()), 2);
  await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; s.history.undo(); s.changed(); });
  expect(await keys(page)).toEqual(before);
});

test("past the last key the Curves view says there is no span", async ({ page }) => {
  const frames = await open(page);
  await page.evaluate((f) => (window as unknown as Live).boneburst.session.seek(f), frames.at(-1)!);
  await expect(page.locator(".panel.motion-path .lp-curves-note")).toContainText("past the last key");
  await expect(page.locator(".panel.motion-path .lp-curves").getByRole("button", { name: /^Bezier:/ })).toBeDisabled();
});

test("a click inside a span on the speed graph puts the playhead there, and the Curves view shows that span (step 3)", async ({ page }) => {
  const frames = await open(page);
  type Pts = { boneburst: { motionPath: { speedPoints: readonly { i: number; x: number; y: number }[] }; session: { frame: number } } };
  await expect.poll(() => page.evaluate(() => (window as unknown as Pts).boneburst.motionPath.speedPoints.length)).toBe(frames.length);
  const pts = await page.evaluate(() => (window as unknown as Pts).boneburst.motionPath.speedPoints);
  const p2 = pts.find((p) => p.i === 2)!, p3 = pts.find((p) => p.i === 3)!, box = (await page.locator(".panel.motion-path .lp-speed-canvas").boundingBox())!;
  await page.mouse.click(box.x + (p2.x + p3.x) / 2, box.y + p2.y - 20);
  const frame = await page.evaluate(() => (window as unknown as Pts).boneburst.session.frame);
  expect(frame).toBeGreaterThan(frames[2]!);
  expect(frame).toBeLessThan(frames[3]!);
  // The Curves view's handles belong to that span: Bezier on, it writes key 3's curve.
  await page.locator(".panel.motion-path .lp-curves").getByRole("button", { name: /^Bezier:/ }).click();
  expect(Array.isArray((await keys(page))[2]!.curve)).toBe(true);
});

test("on a Broken key, a handle dragged in Curves moves only its side; the data row's fields still write (step 4)", async ({ page }) => {
  const frames = await open(page);
  await page.evaluate((f) => (window as unknown as Live).boneburst.session.seek(f), frames[1]!);
  const panel = page.locator(".panel.motion-path"), speedIn = panel.getByRole("spinbutton", { name: "Speed in" }), speedOut = panel.getByRole("spinbutton", { name: "Speed out" });
  await panel.getByRole("button", { name: "Broken", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Broken", exact: true })).toHaveAttribute("aria-pressed", "true");
  const inBefore = await speedIn.inputValue();
  await expect.poll(async () => (await handles(page)).length).toBe(2);
  const out = (await handles(page)).find((h) => h.side === "out")!, box = (await panel.locator(".lp-curves-canvas").boundingBox())!;
  await page.mouse.move(box.x + out.x, box.y + out.y);
  await page.mouse.down();
  await page.mouse.move(box.x + out.x, box.y + out.y - 25, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => Number(await speedOut.inputValue())).toBeGreaterThan(0.2);
  expect(await speedIn.inputValue()).toBe(inBefore);
  // The fields stay the place to type a value: Speed in typed is written, out kept (Broken).
  const outNow = await speedOut.inputValue();
  await speedIn.fill("0.5");
  await speedIn.press("Enter");
  await expect(speedIn).toHaveValue("0.5");
  expect(await speedOut.inputValue()).toBe(outNow);
});

/** A canvas's colour at a point, as #rrggbb. */
const colourAt = (page: Page, sel: string, x: number, y: number) => page.locator(sel).evaluate((c: HTMLCanvasElement, [px, py]) => {
  const k = c.width / c.getBoundingClientRect().width, d = c.getContext("2d")!.getImageData(Math.round(px! * k), Math.round(py! * k), 1, 1).data;
  return `#${[d[0]!, d[1]!, d[2]!].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}, [x, y] as const);
type Pics = { boneburst: { motionPath: { grabPoints: { marks: number[] }; speedPoints: readonly { i: number; x: number; y: number }[]; keyHandlePoints: readonly { i: number; side: string; x: number; y: number }[] } } };

test("a Curves drag changes the preview graph, not the path: the keys' dots in the picture stay (step 5)", async ({ page }) => {
  const frames = await open(page);
  await page.evaluate((f) => (window as unknown as Live).boneburst.session.seek(f), frames[1]!);
  const dots = () => page.evaluate((fs) => { const m = (window as unknown as Pics).boneburst.motionPath.grabPoints.marks; return fs.map((f) => [Math.round(m[f * 2]!), Math.round(m[f * 2 + 1]!)]); }, frames);
  const graph = () => page.evaluate(() => (window as unknown as Pics).boneburst.motionPath.speedPoints.map((p) => Math.round(p.y)));
  await expect.poll(async () => (await handles(page)).length).toBe(2);
  const dotsBefore = await dots(), graphBefore = await graph();
  const out = (await handles(page)).find((h) => h.side === "out")!, box = (await page.locator(".panel.motion-path .lp-curves-canvas").boundingBox())!;
  await page.mouse.move(box.x + out.x, box.y + out.y);
  await page.mouse.down();
  await page.mouse.move(box.x + out.x + 15, box.y + out.y - 30, { steps: 5 });
  await page.mouse.up();
  await expect.poll(graph).not.toEqual(graphBefore);
  expect(await dots()).toEqual(dotsBefore);
});

test("on a curved span an up drag in Curves changes the path handle along the chord only: its bend across stays (Decision 1)", async ({ page }) => {
  const frames = await open(page);
  await page.evaluate((f) => (window as unknown as Live).boneburst.session.seek(f), frames[2]!);
  const panel = page.locator(".panel.motion-path");
  await panel.getByRole("button", { name: "Mirror", exact: true }).click();
  // Key 3's out handle in the file, and its span's chord.
  const geo = () => page.evaluate(() => {
    const k = (window as unknown as Live).boneburst.session.doc.animations[0]!.bones!.find((b) => b.name === "hips")!.timelines.find((t) => t.name === "translate")!.keys;
    const a = k[2]!, b = k[3]!, c = a.curve as number[], h = [c[1]! - (a.x ?? 0), c[5]! - (a.y ?? 0)], ch = [(b.x ?? 0) - (a.x ?? 0), (b.y ?? 0) - (a.y ?? 0)], l = Math.hypot(ch[0]!, ch[1]!);
    return { across: (h[0]! * ch[1]! - h[1]! * ch[0]!) / l, along: (h[0]! * ch[0]! + h[1]! * ch[1]!) / l };
  });
  // Bend the span after key 3: its out handle's tip on the picture dragged off the line.
  await expect.poll(() => page.evaluate(() => (window as unknown as Pics).boneburst.motionPath.keyHandlePoints.filter((h) => h.i === 2).length)).toBe(2);
  const tip = (await page.evaluate(() => (window as unknown as Pics).boneburst.motionPath.keyHandlePoints)).find((h) => h.i === 2 && h.side === "out")!;
  const pic = (await panel.locator(".lp-body canvas").boundingBox())!;
  await page.mouse.move(pic.x + tip.x, pic.y + tip.y);
  await page.mouse.down();
  await page.mouse.move(pic.x + tip.x + 6, pic.y + tip.y - 30, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => Array.isArray((await keys(page))[2]!.curve)).toBe(true);
  const before = await geo();
  expect(Math.abs(before.across)).toBeGreaterThan(0.5);
  // The Curves view shows the playhead's span: back on key 3.
  await page.evaluate((f) => (window as unknown as Live).boneburst.session.seek(f), frames[2]!);
  // Clicking Mirror in the data row scrolled the area under the picture to it: back to the top, the Curves view in sight.
  await panel.locator(".lp-data").evaluate((e) => { e.scrollTop = 0; });
  // Until the Curves view has drawn that span: its handles the same on two reads a frame apart.
  await expect.poll(async () => { const a = JSON.stringify(await handles(page)); await page.waitForTimeout(60); return a === JSON.stringify(await handles(page)) && (await handles(page)).length === 2; }).toBe(true);
  const out = (await handles(page)).find((h) => h.side === "out")!, box = (await panel.locator(".lp-curves-canvas").boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + out.x, box.y + out.y);
  await page.mouse.down();
  await page.mouse.move(box.x + out.x + 1, box.y + out.y - 30, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  const after = await geo();
  expect(after.along).toBeGreaterThan(before.along + 0.5);
  expect(after.across).toBeCloseTo(before.across, 2);
});

test("the Curves handles are drawn in the leg colours, and Hybrid paints the Curves view light gray (step 5)", async ({ page }) => {
  const frames = await open(page);
  await page.evaluate((f) => (window as unknown as Live).boneburst.session.seek(f), frames[1]!);
  await expect.poll(async () => (await handles(page)).length).toBe(2);
  const sel = ".panel.motion-path .lp-curves-canvas";
  for (const h of await handles(page)) await expect.poll(() => colourAt(page, sel, h.x, h.y)).toBe(h.side === "in" ? "#38b6ff" : "#ff5c8a");
  await page.getByRole("button", { name: /^Preferences/ }).click();
  await page.getByRole("combobox", { name: "Theme" }).selectOption({ label: "Hybrid" });
  await page.keyboard.press("Escape");
  await expect.poll(() => colourAt(page, sel, 2, 2)).toBe("#d3d3d3");
});

test("the line between Curves and the graph resizes the Curves view, is kept, and double-click puts it back (step 5)", async ({ page }) => {
  await open(page);
  const curves = page.locator(".panel.motion-path .lp-curves"), split = page.locator(".panel.motion-path .lp-curves-split");
  const width = async () => Math.round((await curves.boundingBox())!.width);
  const w0 = await width(), s = (await split.boundingBox())!;
  await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2 + 60, s.y + s.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect.poll(width).toBeGreaterThan(w0 + 40);
  expect(Number(await page.evaluate(() => localStorage.getItem("boneburst.motionPath.curvesWidth")))).toBeGreaterThan(w0 + 40);
  await split.dblclick();
  await expect.poll(width).toBe(w0);
});

test("step 7: square Curves buttons; no square at a key on the graph; a fast stretch drawn green, a slow one red", async ({ page }) => {
  const frames = await open(page);
  const panel = page.locator(".panel.motion-path");
  for (const b of await panel.locator(".lp-curves-bar button").all()) {
    const box = (await b.boundingBox())!;
    expect(Math.round(box.width)).toBe(Math.round(box.height));
  }
  // No square at key 2's place: just off the line, where the square's corner was, is the graph's background now.
  await page.evaluate((f) => (window as unknown as Live).boneburst.session.seek(f), frames[1]!);
  type P = { boneburst: { motionPath: { speedPoints: readonly { i: number; x: number; y: number }[] } } };
  await expect.poll(() => page.evaluate(() => (window as unknown as P).boneburst.motionPath.speedPoints.length)).toBe(frames.length);
  const p = (await page.evaluate(() => (window as unknown as P).boneburst.motionPath.speedPoints)).find((q) => q.i === 1)!;
  const sel = ".panel.motion-path .lp-speed-canvas";
  expect(await colourAt(page, sel, p.x + 3, p.y - 3)).toBe(await colourAt(page, sel, p.x + 3, p.y - 30));
  // Key 2 three times as fast (Linked: both sides): green near it; then slow: red.
  const count = (hue: "green" | "red") => page.locator(sel).evaluate((c: HTMLCanvasElement, h) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (h === "green" ? d[i + 1]! > 200 && d[i]! < 140 && d[i + 2]! < 160 : d[i]! > 200 && d[i + 1]! < 140 && d[i + 2]! < 70) n++;
    return n;
  }, hue);
  const speedOut = panel.getByRole("spinbutton", { name: "Speed out" });
  await speedOut.fill("3");
  await speedOut.press("Enter");
  await expect.poll(() => count("green")).toBeGreaterThan(15);
  await speedOut.fill("-0.9");
  await speedOut.press("Enter");
  // Redder than the orange (its green channel 159): a slow stretch is short, partly red.
  await expect.poll(() => count("red")).toBeGreaterThan(8);
});
