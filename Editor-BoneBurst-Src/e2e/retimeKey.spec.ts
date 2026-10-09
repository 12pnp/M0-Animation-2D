import { expect, type Page, test } from "@playwright/test";

/** ⌘ + drag a diamond on FramePath's strip (docs/FRAMEPATH-SPEED-PLAN.md, step 16): the key moves in time, its place and the picture stay. */

type Key = { time?: number; x?: number; y?: number };
type Live = { boneburst: { session: { select(s: unknown): void; seek(f: number): void; fps: number; frame: number; history: { undo(): void }; changed(): void; doc: { animations: { bones?: { name: string; timelines: { name: string; keys: Key[] }[] }[] }[] } }; motionPath: { stripPoints: readonly { i: number; x: number }[]; grabPoints: { marks: number[] } } } };

const keys = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.doc.animations[0]!.bones!.find((b) => b.name === "hips")!.timelines.find((t) => t.name === "translate")!.keys.map((k) => ({ t: k.time ?? 0, x: k.x ?? 0, y: k.y ?? 0 })));

test("⌘ + drag on a strip diamond slides the key in time; its place and its dot in the picture stay; one undo step puts it back", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^FramePath$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  await expect.poll(() => page.evaluate(() => (window as unknown as Live).boneburst.motionPath.stripPoints.length)).toBeGreaterThan(3);
  const before = await keys(page), fps = await page.evaluate(() => (window as unknown as Live).boneburst.session.fps);
  const frame = (t: number) => Math.round(t * fps);
  // Key 3's dot in the picture before (the marks are per frame, on the panel's canvas).
  const mark = (f: number) => page.evaluate((n) => (window as unknown as Live).boneburst.motionPath.grabPoints.marks.slice(n * 2, n * 2 + 2), f);
  const dotBefore = await mark(frame(before[2]!.t));
  const pts = await page.evaluate(() => (window as unknown as Live).boneburst.motionPath.stripPoints.map((p) => p.x));
  const box = (await page.locator(".lp-keystrip").boundingBox())!, perFrame = (pts[3]! - pts[2]!) / (frame(before[3]!.t) - frame(before[2]!.t));
  // Two frames later: ⌘ held over the diamond, then pressed and dragged.
  await page.mouse.move(box.x + pts[2]!, box.y + 35);
  await page.keyboard.down("Meta");
  await page.mouse.move(box.x + pts[2]! + 1, box.y + 35);
  await expect(page.locator(".lp-keystrip")).toHaveCSS("cursor", "ew-resize");
  await page.mouse.down();
  await page.mouse.move(box.x + pts[2]! + perFrame * 2, box.y + 35, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Meta");
  const after = await keys(page);
  expect(frame(after[2]!.t)).toBe(frame(before[2]!.t) + 2);
  expect(after.map((k) => [k.x, k.y])).toEqual(before.map((k) => [k.x, k.y]));
  expect(after.filter((_, i) => i !== 2).map((k) => k.t)).toEqual(before.filter((_, i) => i !== 2).map((k) => k.t));
  // Its dot in the picture is where it was (its place is the same; see the keys above), now on the new frame; and the playhead went with it.
  const dotAfter = await mark(frame(after[2]!.t));
  // Within 2 px: the view refits to the frames' points, which sample the same path at other moments.
  expect(Math.abs(dotAfter[0]! - dotBefore[0]!)).toBeLessThan(2);
  expect(Math.abs(dotAfter[1]! - dotBefore[1]!)).toBeLessThan(2);
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.frame)).toBe(frame(after[2]!.t));
  // One undo step.
  await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; s.history.undo(); s.changed(); });
  expect(await keys(page)).toEqual(before);
});
