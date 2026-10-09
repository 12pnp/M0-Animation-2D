import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

/** The analysis window a Spine export opens with (docs/SPINE-IMPORT-FRAMEPATH-PLAN.md, step 2). */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = (name: string, text: string | Buffer) => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from(text) });
/** A small export whose hips keep x and y as separate lists. */
const SPLIT = JSON.stringify({
  skeleton: { spine: "4.3.0", fps: 10 },
  bones: [{ name: "root" }, { name: "hips", parent: "root" }],
  animations: { walk: { bones: { hips: { translatex: [{ value: 0, curve: [0.3, 0, 0.6, 12] }, { time: 1, value: 10 }], translatey: [{ value: 0 }, { time: 0.5, value: 20 }, { time: 1, value: 0 }] } } } },
});
type Live = { boneburst: { session: { doc: { animations: { bones?: { name: string; timelines: { name: string }[] }[] }[] } | null; history: { undo(): void }; changed(): void } } };
const timelines = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.doc?.animations[0]?.bones?.find((b) => b.name === "hips")?.timelines.map((t) => t.name) ?? null);

async function start(page: Page): Promise<ReturnType<Page["locator"]>> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  return page.locator('input[type=file][accept*=".psd"]');
}

test("a split export: the window says what it found; Convert to FramePath opens it with one translate list, one undo step back to the file", async ({ page }) => {
  const open = await start(page);
  await open.setInputFiles([file("walker.json", SPLIT)]);
  const win = page.getByRole("dialog", { name: "Open: analysis" });
  await expect(win).toContainText("Open walker.json");
  await expect(win).toContainText("1 bone keeps x and y as separate lists".replace("keeps", "keep"));
  await win.getByRole("tab", { name: "Where (1)" }).click();
  await expect(win.locator("tbody tr")).toHaveText([/walk\s*hips\s*separate x \(2 keys\) and y \(3\)/]);
  await expect(win.locator(".result").first()).toContainText("Converting adds");
  await win.getByRole("button", { name: "Convert to FramePath and open" }).click();
  await expect(win).toHaveCount(0);
  await expect.poll(() => timelines(page)).toEqual(["translate"]);
  await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; s.history.undo(); s.changed(); });
  await expect.poll(() => timelines(page)).toEqual(["translatex", "translatey"]);
});

test("Open as is keeps the lists; Cancel opens nothing", async ({ page }) => {
  const open = await start(page);
  await open.setInputFiles([file("walker.json", SPLIT)]);
  const win = page.getByRole("dialog", { name: "Open: analysis" });
  await win.getByRole("button", { name: "Cancel" }).click();
  await expect(win).toHaveCount(0);
  expect(await timelines(page)).toBeNull();
  await expect(page.locator(".message")).toContainText("Nothing was opened");
  await open.setInputFiles([file("walker.json", SPLIT)]);
  await win.getByRole("button", { name: "Open as is" }).click();
  await expect.poll(() => timelines(page)).toEqual(["translatex", "translatey"]);
});

test("the timing options and the tolerance are there; Leave turns the tolerance off", async ({ page }) => {
  const open = await start(page);
  await open.setInputFiles([file("walker.json", SPLIT)]);
  const win = page.getByRole("dialog", { name: "Open: analysis" });
  await win.getByRole("tab", { name: "Convert" }).click();
  const tol = win.getByRole("spinbutton", { name: "Tolerance" });
  await expect(tol).toHaveValue("0.5");
  await expect(win.getByRole("radio", { name: /Match, and cut spans/ })).toBeChecked();
  await win.getByRole("radio", { name: /Leave the timing/ }).check();
  await expect(tol).toBeDisabled();
  await win.getByRole("radio", { name: /Match only/ }).check();
  await expect(tol).toBeDisabled();
  await win.getByRole("radio", { name: /Match, and cut spans/ }).check();
  await expect(tol).toBeEnabled();
});

test("an export FramePath takes as it is says so, with Open; a .skel alone is said and not opened", async ({ page }) => {
  const open = await start(page);
  const clean = JSON.stringify({ skeleton: { spine: "4.3.0" }, bones: [{ name: "root" }, { name: "hips", parent: "root" }], animations: { walk: { bones: { hips: { translate: [{ x: 0, y: 0 }, { time: 1, x: 5, y: 5 }] } } } } });
  await open.setInputFiles([file("clean.json", clean)]);
  const win = page.getByRole("dialog", { name: "Open: analysis" });
  await expect(win).toContainText("FramePath can edit every bone's motion as it is");
  await expect(win).toContainText("not set (30 fps)");
  await win.getByRole("button", { name: "Open", exact: true }).click();
  await expect.poll(() => timelines(page)).toEqual(["translate"]);
  await open.setInputFiles([file("hero.skel", "binary"), file("hero.atlas.txt", "")]);
  await expect(win).toContainText("Spine's binary export");
  await win.getByRole("button", { name: "Close" }).click();
  await expect(page.locator(".message")).toContainText("Nothing was opened");
});

test("the owner's sample: 22 bones with separate lists and 21 curves timed apart, said", async ({ page }) => {
  const open = await start(page);
  const dir = join(ROOT, "..", "Assets", "Samples Custom", "BoneBurstDemo", "mix-and-match-pro");
  await open.setInputFiles([join(dir, "mix-and-match-pro.json"), join(dir, "mix-and-match-pro.atlas.txt"), join(dir, "mix-and-match-pro.png")]);
  const win = page.getByRole("dialog", { name: "Open: analysis" });
  await expect(win).toContainText("22 bones keep x and y as separate lists");
  await expect(win).toContainText("21 curves time x and y apart");
  await expect(win.locator(".result").first()).toContainText("Converting adds", { timeout: 20_000 });
});

test("opened as is, later: the split bone's hint offers Convert…, and FramePath's ⋮ menu Convert to FramePath…; each one undo step (step 3)", async ({ page }) => {
  const open = await start(page);
  await open.setInputFiles([file("walker.json", SPLIT)]);
  await page.getByRole("dialog", { name: "Open: analysis" }).getByRole("button", { name: "Open as is" }).click();
  await expect.poll(() => timelines(page)).toEqual(["translatex", "translatey"]);
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^FramePath$/ }).click();
  await page.evaluate(() => (window as unknown as { boneburst: { session: { select(s: unknown): void } } }).boneburst.session.select({ kind: "bone", name: "hips" }));
  const panel = page.locator(".panel.motion-path");
  await expect(panel.locator(".lp-motion .lp-hint")).toContainText("separate x and y");
  await panel.getByRole("button", { name: "Convert…" }).click();
  const win = page.getByRole("dialog", { name: "Convert to FramePath" });
  await expect(win).toContainText("1 bone keeps x and y as separate lists".replace("keeps", "keep"));
  await expect(win.getByRole("button", { name: "Open as is" })).toHaveCount(0);
  await win.getByRole("button", { name: "Convert", exact: true }).click();
  await expect.poll(() => timelines(page)).toEqual(["translate"]);
  await expect(panel.getByRole("button", { name: "Convert…" })).toHaveCount(0);
  await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; s.history.undo(); s.changed(); });
  await expect.poll(() => timelines(page)).toEqual(["translatex", "translatey"]);
  // The ⋮ menu: the same window, the same conversion.
  await panel.getByRole("button", { name: "FramePath menu" }).click();
  await page.getByRole("menuitem", { name: "Convert to FramePath…" }).click();
  await win.getByRole("button", { name: "Convert", exact: true }).click();
  await expect.poll(() => timelines(page)).toEqual(["translate"]);
  // Nothing left to convert: the menu item is off.
  await panel.getByRole("button", { name: "FramePath menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Convert to FramePath…" })).toBeDisabled();
});

test("the window: 840 × 1050 held to the screen; tabs Summary · Where · Convert, one shown at a time, the buttons always in sight", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1200 });
  const open = await start(page);
  await open.setInputFiles([file("walker.json", SPLIT)]);
  const win = page.getByRole("dialog", { name: "Open: analysis" }), box = (await win.boundingBox())!;
  expect(Math.round(box.width)).toBe(840);
  expect(Math.round(box.height)).toBe(1050);
  await expect(win.getByRole("tab")).toHaveText(["Summary", "Where (1)", "Convert"]);
  await expect(win.getByRole("tab", { name: "Summary" })).toHaveAttribute("aria-selected", "true");
  await expect(win.getByRole("tabpanel", { name: "Summary" })).toBeVisible();
  await expect(win.getByRole("tabpanel", { name: "Convert" })).toBeHidden();
  await win.getByRole("tab", { name: "Convert" }).click();
  await expect(win.getByRole("tabpanel", { name: "Convert" })).toBeVisible();
  await expect(win.getByRole("tabpanel", { name: "Summary" })).toBeHidden();
  await expect(win.getByRole("button", { name: "Convert to FramePath and open" })).toBeVisible();
});
