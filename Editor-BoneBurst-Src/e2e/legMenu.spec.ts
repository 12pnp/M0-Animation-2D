import { expect, type Page, test } from "@playwright/test";

/** ⌘ + click a key's dot on FramePath's picture for its leg mode; the in and out legs in their own colours (docs/FRAMEPATH-SPEED-PLAN.md, step 19). */

type Live = { boneburst: { session: { select(s: unknown): void; seek(f: number): void; fps: number; frame: number; doc: { animations: { bones?: { name: string; timelines: { name: string; keys: { time?: number }[] }[] }[] }[] } }; motionPath: { grabPoints: { marks: number[] }; keyHandlePoints: readonly { i: number; side: "in" | "out"; x: number; y: number }[] } } };

async function open(page: Page, prefs?: string): Promise<number[]> {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto("/");
  await page.evaluate((p) => { localStorage.clear(); if (p) localStorage.setItem("boneburst.preferences", p); }, prefs ?? null);
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  return page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; return s.doc.animations[0]!.bones!.find((b) => b.name === "hips")!.timelines.find((t) => t.name === "translate")!.keys.map((k) => Math.round((k.time ?? 0) * s.fps)); });
}

const picture = (page: Page) => page.locator(".panel.motion-path .lp-body canvas");
/** The picture's colour at a canvas point, as #rrggbb. */
const colourAt = (page: Page, x: number, y: number) => picture(page).evaluate((c: HTMLCanvasElement, [px, py]) => {
  const k = c.width / c.getBoundingClientRect().width, d = c.getContext("2d")!.getImageData(Math.round(px! * k), Math.round(py! * k), 1, 1).data;
  return `#${[d[0]!, d[1]!, d[2]!].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}, [x, y] as const);
const tips = (page: Page, i: number) => page.evaluate((n) => (window as unknown as Live).boneburst.motionPath.keyHandlePoints.filter((h) => h.i === n), i);

test("⌘ + click a key's dot opens Mirror · Break · Plain; Mirror gives it legs, in and out in their two colours", async ({ page }) => {
  const frames = await open(page);
  const f = frames[2]!;
  await page.evaluate((n) => (window as unknown as Live).boneburst.session.seek(n), frames[0]!);
  const mark = () => page.evaluate((n) => (window as unknown as Live).boneburst.motionPath.grabPoints.marks.slice(n * 2, n * 2 + 2), f);
  await expect.poll(async () => { const m = await mark(); return m.length === 2 && m.every((v) => Number.isFinite(v)); }).toBe(true);
  const [mx, my] = await mark();
  const box = (await picture(page).boundingBox())!;
  await page.keyboard.down("Meta");
  await page.mouse.click(box.x + mx!, box.y + my!);
  await page.keyboard.up("Meta");
  // The playhead went to the key, and its mode is checked (a fixture key starts Plain).
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.frame)).toBe(f);
  await expect(page.getByRole("menuitemcheckbox", { name: /Plain: key 3 with/ })).toHaveAttribute("aria-checked", "true");
  await page.getByRole("menuitemcheckbox", { name: /Mirror: key 3's/ }).click();
  await expect.poll(async () => (await tips(page, 2)).length).toBe(2);
  const t = await tips(page, 2), tin = t.find((h) => h.side === "in")!, tout = t.find((h) => h.side === "out")!;
  await expect.poll(() => colourAt(page, tin.x, tin.y)).toBe("#38b6ff");
  await expect.poll(() => colourAt(page, tout.x, tout.y)).toBe("#ff5c8a");
});

test("a leg colour set in Preferences reaches the picture", async ({ page }) => {
  const prefs = JSON.stringify({ version: 2, theme: "light", themes: [{ id: "light", name: "Light", base: "light", values: { legOutColour: "#00c000" } }] });
  const frames = await open(page, prefs);
  await page.evaluate((n) => (window as unknown as Live).boneburst.session.seek(n), frames[2]!);
  await page.locator(".panel.motion-path").getByRole("button", { name: "Mirror", exact: true }).click();
  await expect.poll(async () => (await tips(page, 2)).length).toBe(2);
  const tout = (await tips(page, 2)).find((h) => h.side === "out")!;
  await expect.poll(() => colourAt(page, tout.x, tout.y)).toBe("#00c000");
});
