import { expect, type Page, test } from "@playwright/test";

/** On FramePath's picture, ⌘ + click the path adds a key; Shift + click a key's dot deletes it (docs/FRAMEPATH-SPEED-PLAN.md, step 20). */

type Live = { boneburst: { session: { select(s: unknown): void; seek(f: number): void; fps: number; frame: number; history: { entries: { done: number } }; doc: { animations: { bones?: { name: string; timelines: { name: string; keys: { time?: number; x?: number; y?: number }[] }[] }[] }[] } }; motionPath: { grabPoints: { marks: number[] } } } };

const keys = (page: Page) => page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; return s.doc.animations[0]!.bones!.find((b) => b.name === "hips")!.timelines.find((t) => t.name === "translate")!.keys.map((k) => ({ f: Math.round((k.time ?? 0) * s.fps), x: k.x ?? 0, y: k.y ?? 0 })); });
const mark = (page: Page, f: number) => page.evaluate((n) => (window as unknown as Live).boneburst.motionPath.grabPoints.marks.slice(n * 2, n * 2 + 2), f);
const steps = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.history.entries.done);

test("⌘ + click on the path between two keys adds one there, the path unchanged; Shift + click on its dot deletes it", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^FramePath$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  const before = await keys(page), f = Math.floor((before[1]!.f + before[2]!.f) / 2);
  // The playhead on the key before: where the path passes the spot again later, the frame nearest the playhead is the one taken.
  await page.evaluate((n) => (window as unknown as Live).boneburst.session.seek(n), before[1]!.f);
  expect(before.some((k) => k.f === f)).toBe(false);
  // Until the picture is drawn: the mark the same on two reads a frame apart. A click right on a mark picks that frame.
  await expect.poll(async () => { const m1 = await mark(page, f); await page.waitForTimeout(50); const m2 = await mark(page, f); return m1.length === 2 && m1.every(Number.isFinite) && m1[0] === m2[0] && m1[1] === m2[1]; }).toBe(true);
  const at = await mark(page, f), box = (await page.locator(".panel.motion-path .lp-body canvas").boundingBox())!, done = await steps(page);
  await page.keyboard.down("Meta");
  await page.mouse.click(box.x + at[0]!, box.y + at[1]!);
  await page.keyboard.up("Meta");
  await expect.poll(async () => (await keys(page)).length).toBe(before.length + 1);
  // The new key is between the two (where the bone stands still several frames share the spot clicked: the one nearest the playhead is taken).
  const added = (await keys(page)).find((k) => !before.some((b) => b.f === k.f))!;
  expect(added.f).toBeGreaterThan(before[1]!.f);
  expect(added.f).toBeLessThan(before[2]!.f);
  expect(await steps(page)).toBe(done + 1);
  // The path is where it was: the new key's dot sits on the spot clicked.
  const now = await mark(page, added.f);
  expect(Math.abs(now[0]! - at[0]!)).toBeLessThan(1);
  expect(Math.abs(now[1]! - at[1]!)).toBeLessThan(1);
  // Shift + click on that dot deletes the key.
  await page.keyboard.down("Shift");
  await page.mouse.click(box.x + now[0]!, box.y + now[1]!);
  await page.keyboard.up("Shift");
  await expect.poll(() => keys(page)).toEqual(before);
  expect(await steps(page)).toBe(done + 2);
});
