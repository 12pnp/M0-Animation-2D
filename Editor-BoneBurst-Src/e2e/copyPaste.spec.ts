import { expect, type Page, test } from "@playwright/test";

/**
 * Copy and paste (E6-PLAN step 4c): keys selected with a box, copied and pasted at the playhead
 * with their spacing, one undo step; ⌘A; a pose copied from one animation and pasted into another.
 */

type Doc = { animations: { name: string; bones?: { name: string; timelines: { name: string; keys: { time?: number; value?: number }[] }[] }[] }[] };
type Live = { boneburst: { session: { doc: Doc; seek(f: number): void; selectBone(n: string | null): void; pose(): { bones: Map<string, number>; local: Float32Array | Float64Array } | null } } };

/** The head's local rotation as the editor poses it now. */
const headRotation = (page: Page) => page.evaluate(() => {
  const p = (window as unknown as Live).boneburst.session.pose()!;
  return Math.round(p.local[p.bones.get("head")! * 7 + 2]! * 1000) / 1000;
});

/** Frames (24 fps) of `bone`'s `timeline` keys in `anim`. */
const frames = (page: Page, anim: string, bone: string, timeline: string) => page.evaluate(([a, b, t]) => {
  const d = (window as unknown as Live).boneburst.session.doc;
  return (d.animations.find((x) => x.name === a)!.bones?.find((g) => g.name === b)?.timelines.find((x) => x.name === t)?.keys ?? []).map((k) => Math.round((k.time ?? 0) * 24));
}, [anim, bone, timeline] as const);

/** The page point of frame `f` on the timeline row named `name` (scrolled into view). */
async function at(page: Page, name: string, f: number): Promise<{ x: number; y: number }> {
  const label = page.locator(".timeline-labels .row").filter({ hasText: new RegExp(`^\\W*${name}$`) }).first();
  await label.scrollIntoViewIfNeeded();
  const row = (await label.boundingBox())!, track = (await page.locator(".timeline-track canvas").boundingBox())!;
  return { x: track.x + (f + 0.5) * 12, y: row.y + row.height / 2 };
}

test("box-select keys, copy, paste at the playhead with their spacing (one undo); ⌘A; a pose pasted into another animation", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".timeline select").first().selectOption("run");
  const before = await frames(page, "run", "hips", "rotate");
  expect(before.slice(0, 3)).toEqual([0, 2, 4]);

  // A box over hips' row, started on empty track between frames 4 and 6 and dragged left past frame 0.
  const a = await at(page, "hips", 4.6), b = await at(page, "hips", -0.45);
  await page.mouse.move(a.x, a.y - 8);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y + 8, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.press("ControlOrMeta+c");
  await expect(page.locator(".status, footer, .message").getByText(/Copied \d+ keys/).first()).toBeVisible();

  // Pasted at frame 20: hips' keys at 20, 22, 24 as at 0, 2, 4.
  await page.evaluate(() => (window as unknown as Live).boneburst.session.seek(20));
  await page.keyboard.press("ControlOrMeta+v");
  await expect.poll(() => frames(page, "run", "hips", "rotate")).toEqual([...before, 20, 22, 24].filter((f, i, all) => all.indexOf(f) === i).sort((x, y) => x - y));
  // One undo step takes the whole paste back.
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => frames(page, "run", "hips", "rotate")).toEqual(before);

  // ⌘A selects every key: copying says how many.
  await page.locator(".timeline-track canvas").click({ position: { x: 300, y: 5 } });
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("ControlOrMeta+c");
  await expect(page.locator(".message").getByText(/Copied \d{2,} keys/)).toBeVisible();

  // A pose: the head in run at frame 3, pasted into dance at frame 10.
  await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; s.selectBone("head"); s.seek(3); });
  const copied = await headRotation(page);
  await page.keyboard.press("ControlOrMeta+Alt+c");
  await expect(page.locator(".message")).toContainText("Copied the pose of head");
  await page.locator(".timeline select").first().selectOption("dance");
  await page.evaluate(() => (window as unknown as Live).boneburst.session.seek(10));
  expect(await headRotation(page)).not.toBe(copied);
  await page.keyboard.press("ControlOrMeta+Alt+v");
  await expect(page.locator(".message")).toContainText("Pasted the pose at frame 10 of dance");
  // Keyed there: the head in dance at frame 10 is posed as it was in run at frame 3.
  expect(await frames(page, "dance", "head", "rotate")).toContain(10);
  expect(await headRotation(page)).toBe(copied);
});
