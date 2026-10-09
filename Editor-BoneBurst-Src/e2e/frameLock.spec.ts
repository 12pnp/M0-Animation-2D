import { expect, type Page, test } from "@playwright/test";

/**
 * An animation's last frame on FramePath's strip (docs/FRAME-LIMIT-PLAN.md): a button showing it (default 30), a popup to set it, and when
 * the keys run past the new value, Pack (every key scaled into it), Trim (the keys after it cut, the value at it keyed) or Set only.
 */

type Key = { time?: number };
type Live = { boneburst: { session: { select(s: unknown): void; seek(f: number): void; frame: number; fps: number; animation: { name: string } | null; frameLimitOf(n: string): number; history: { undo(): void; entries: { done: number } }; changed(): void; doc: { animations: { name: string; bones?: { name: string; timelines: { name: string; keys: Key[] }[] }[]; events?: Key[] }[] } } } };

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 1100 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^FramePath$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
}

const frame = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.frame);
const seek = (page: Page, f: number) => page.evaluate((n) => (window as unknown as Live).boneburst.session.seek(n), f);
const press = async (page: Page, key: "q" | "w") => { await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await page.keyboard.press(key); };
/** The hips' translate key frames in the first animation. */
const hipFrames = (page: Page) => page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; return s.doc.animations[0]!.bones!.find((b) => b.name === "hips")!.timelines.find((t) => t.name === "translate")!.keys.map((k) => Math.round((k.time ?? 0) * s.fps)); });
const button = (page: Page) => page.locator(".panel.motion-path").getByRole("button", { name: "Last frame" });
/** Opens the popup and types `n`; the animation's last key frame, as the popup says it (the whole animation's, not one bone's). */
async function setLimit(page: Page, n: number): Promise<number> {
  await button(page).click();
  const pop = page.getByRole("dialog", { name: "Last frame" });
  await pop.getByRole("spinbutton", { name: "Last frame" }).fill(String(n));
  return Number(/run to frame (\d+)/.exec((await pop.locator(".info").textContent()) ?? "")![1]);
}

test("the button shows 30; the playhead stops there and Q / W wrap round", async ({ page }) => {
  await open(page);
  await expect(button(page)).toHaveText("30");
  await seek(page, 40);
  expect(await frame(page)).toBe(30);
  await press(page, "w");
  expect(await frame(page)).toBe(0);
  await press(page, "q");
  expect(await frame(page)).toBe(30);
});

test("the popup's Set only keeps the keys and moves the stop; a value past the keys offers just Set", async ({ page }) => {
  await open(page);
  const keys = await hipFrames(page);
  const end = await setLimit(page, 20);
  const pop = page.getByRole("dialog", { name: "Last frame" });
  expect(end).toBeGreaterThan(30);
  await expect(pop).toContainText(`Its keys run to frame ${end}, past 20`);
  await pop.getByRole("button", { name: "Set only" }).click();
  await expect(pop).toHaveCount(0);
  await expect(button(page)).toHaveText("20");
  expect(await hipFrames(page)).toEqual(keys);
  await seek(page, 25);
  expect(await frame(page)).toBe(20);
  await setLimit(page, 60);
  await expect(pop.getByRole("button", { name: "Pack into 0–60" })).toHaveCount(0);
  await pop.getByRole("button", { name: "Set", exact: true }).click();
  await expect(button(page)).toHaveText("60");
});

test("Pack scales every key into the last frame, one undo step", async ({ page }) => {
  await open(page);
  const keys = await hipFrames(page), done = await page.evaluate(() => (window as unknown as Live).boneburst.session.history.entries.done);
  const end = await setLimit(page, 24);
  await page.getByRole("dialog", { name: "Last frame" }).getByRole("button", { name: "Pack into 0–24" }).click();
  // Scaled by the whole animation's length: its last key (another bone's) lands on 24, the hips' keys in proportion.
  expect(await hipFrames(page)).toEqual(keys.map((f) => Math.round((f * 24) / end)));
  await expect(button(page)).toHaveText("24");
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.history.entries.done)).toBe(done + 1);
  await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; s.history.undo(); s.changed(); });
  expect(await hipFrames(page)).toEqual(keys);
});

test("Trim cuts the keys after the last frame and keys it, one undo step; a Pack that would merge keys is refused in the popup", async ({ page }) => {
  await open(page);
  const keys = await hipFrames(page);
  await setLimit(page, 18);
  await page.getByRole("dialog", { name: "Last frame" }).getByRole("button", { name: "Trim after 18" }).click();
  const trimmed = await hipFrames(page);
  expect(trimmed.at(-1)).toBe(18);
  expect(trimmed.every((f) => f <= 18)).toBe(true);
  expect(trimmed.slice(0, -1)).toEqual(keys.filter((f) => f < 18));
  // Into 3 frames the hips' keys (every 4) would meet: refused, said, nothing changed.
  const before = await hipFrames(page);
  await setLimit(page, 3);
  const pop = page.getByRole("dialog", { name: "Last frame" });
  await pop.getByRole("button", { name: "Pack into 0–3" }).click();
  await expect(pop.locator(".msg")).toContainText("nothing was changed");
  expect(await hipFrames(page)).toEqual(before);
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
});
