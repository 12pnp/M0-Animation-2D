import { expect, type Page, test } from "@playwright/test";
import { chooseParent } from "./motionHelpers";

/** The Motion Path panel's two tabs (docs/MOTION-MODES-PLAN.md): FramePath and TwinSpline, each with a ⋮ menu; both kept, the tab chooses which is used. */

type Live = { boneburst: { session: { sidecar: { motion: { bone: string; nodes: unknown[]; closed: boolean; duration: number; active?: boolean }[] }; doc: { animations: { bones?: { name: string; timelines: { name: string; keys: unknown[] }[] }[] }[] }; select(s: unknown): void; changed(): void } } };

async function open(page: Page, bone: string): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate((b) => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: b }), bone);
}

const panelOf = (page: Page) => page.locator(".panel.motion-path");
const path = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.sidecar.motion[0] ?? null);
const selected = (panel: ReturnType<typeof panelOf>) => panel.getByRole("tab", { selected: true });

test("the tab opens by what the bone has: keys open FramePath (no path editor), nothing opens TwinSpline with a Create new card; the choice stays", async ({ page }) => {
  await open(page, "hips");
  const panel = panelOf(page);
  await expect(selected(panel)).toHaveText("FramePath");
  await expect(panel.getByRole("button", { name: "Edit Path", exact: true })).toBeHidden();
  await expect(panel.locator(".lp-card")).toBeHidden();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "head" }));
  await expect(selected(panel)).toHaveText("TwinSpline");
  await expect(panel.locator(".lp-card")).toContainText("No TwinSpline for head");
  await expect(panel.locator(".lp-card").getByRole("button", { name: "Create new" })).toBeVisible();
  await expect(panel.locator(".lp-card").getByRole("button", { name: /Create from FramePath/ })).toHaveCount(0);
  await panel.getByRole("tab", { name: "FramePath" }).click();
  await expect(selected(panel)).toHaveText("FramePath");
});

test("Create new on the card makes the path; the FramePath tab then uses the keys, with no card", async ({ page }) => {
  await open(page, "head");
  const panel = panelOf(page);
  await chooseParent(panel);
  await panel.locator(".lp-card").getByRole("button", { name: "Create new" }).click();
  await expect.poll(async () => (await path(page))?.bone).toBe("head");
  await expect(panel.locator(".lp-card")).toBeHidden();
  await panel.getByRole("tab", { name: "FramePath" }).click();
  await expect(panel.locator(".lp-card")).toBeHidden();
  await expect(panel.getByRole("button", { name: "Edit Path", exact: true })).toBeHidden();
  await panel.getByRole("tab", { name: "TwinSpline" }).click();
  await expect(selected(panel)).toHaveText("TwinSpline");
  expect((await path(page))?.active).toBeUndefined();
});

test("the ⋮ menus are the two conversions and the two deletes, each off when there is nothing to act on", async ({ page }) => {
  await open(page, "head");
  const panel = panelOf(page);
  await panel.getByRole("button", { name: "FramePath menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Create new TwinSpline from FramePath" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Delete FramePath data" })).toBeDisabled();
  await page.keyboard.press("Escape");
  await panel.getByRole("button", { name: "TwinSpline menu" }).click();
  await expect(page.getByRole("menuitem", { name: "Create new FramePath from TwinSpline" })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Delete TwinSpline data" })).toBeDisabled();
});

test("FramePath ⋮ Closed puts the last frame's translate key where the first one is; and it shows as checked", async ({ page }) => {
  await open(page, "hips");
  const panel = panelOf(page);
  const ends = () => page.evaluate(() => {
    const keys = (window as unknown as Live).boneburst.session.doc.animations[0]!.bones!.find((b) => b.name === "hips")!.timelines.find((t) => t.name === "translate")!.keys as { time?: number; x?: number; y?: number }[];
    const first = keys[0]!, last = keys[keys.length - 1]!;
    return { same: (first.x ?? 0) === (last.x ?? 0) && (first.y ?? 0) === (last.y ?? 0) };
  });
  await panel.getByRole("button", { name: "FramePath menu" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Closed" }).click();
  expect((await ends()).same).toBe(true);
  await panel.getByRole("button", { name: "FramePath menu" }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Closed" })).toHaveAttribute("aria-checked", "true");
});

type Seek = { boneburst: { session: { seek(f: number): void; fps: number; frame: number; doc: { animations: { bones?: { name: string; timelines: { name: string; keys: { time?: number }[] }[] }[] }[] } } } };
const hipsKeys = (page: Page) => page.evaluate(() => (window as unknown as Seek).boneburst.session.doc.animations[0]!.bones!.find((b) => b.name === "hips")!.timelines.find((t) => t.name === "translate")!.keys.map((k) => k.time ?? 0));

test("FramePath: no green buttons but a frame strip; the key on the playhead's frame shows its data, and a speed typed there is written into the keys' curves", async ({ page }) => {
  await open(page, "hips");
  const panel = panelOf(page);
  const times = await hipsKeys(page), count = times.length;
  await expect(panel.locator(".lp-slots button.node")).toHaveCount(0);
  await expect(panel.locator(".lp-keystrip")).toBeVisible();
  // A press on the strip at key 2's frame puts the playhead there.
  await page.evaluate((t) => { const s = (window as unknown as Seek).boneburst.session; s.seek(Math.round(t * s.fps)); }, times[1]!);
  await expect(panel.locator(".lp-fields .title")).toContainText(`Key 2 of ${count}`);
  // In Mirror the out speed is the in speed too.
  const speed = panel.getByRole("spinbutton", { name: "Speed out" });
  await speed.fill("2");
  await speed.press("Enter");
  const curves = () => page.evaluate(() => ((window as unknown as Live).boneburst.session.doc.animations[0]!.bones!.find((b) => b.name === "hips")!.timelines.find((t) => t.name === "translate")!.keys as { curve?: unknown }[]).slice(0, 2).map((k) => Array.isArray(k.curve)));
  await expect.poll(curves).toEqual([true, true]);
  await expect(panel.locator(".lp-fields .read")).toHaveText(["×3", "×3"]);
  // One undo step takes the speed back out of both curves.
  await page.evaluate(() => { const s = (window as unknown as { boneburst: { session: { history: { undo(): void }; changed(): void } } }).boneburst.session; s.history.undo(); s.changed(); });
  await expect.poll(curves).toEqual([false, false]);
});

test("FramePath ◆ keys the bone's place on a frame with no key and deletes the key on a frame with one", async ({ page }) => {
  await open(page, "hips");
  const panel = panelOf(page);
  const times = await hipsKeys(page), fps = await page.evaluate(() => (window as unknown as Seek).boneburst.session.fps);
  const frames = new Set(times.map((t) => Math.round(t * fps)));
  let free = 1;
  while (frames.has(free)) free++;
  await page.evaluate((f) => (window as unknown as Seek).boneburst.session.seek(f), free);
  await expect(panel.locator(".lp-keyhint")).toContainText(`Frame ${free}: no translate key`);
  await panel.getByRole("button", { name: "Toggle key" }).click();
  await expect.poll(async () => (await hipsKeys(page)).length).toBe(times.length + 1);
  await expect(panel.locator(".lp-fields .title")).toContainText(`frame ${free}`);
  await panel.getByRole("button", { name: "Toggle key" }).click();
  await expect.poll(async () => (await hipsKeys(page)).length).toBe(times.length);
});

type Points = { boneburst: { motionPath: { speedPoints: readonly { i: number; x: number; y: number }[]; stripPoints: readonly { i: number; x: number }[] } } };
const goToKey = async (page: Page, n: number): Promise<void> => {
  const times = await hipsKeys(page);
  await page.evaluate((t) => { const s = (window as unknown as Seek).boneburst.session; s.seek(Math.round(t * s.fps)); }, times[n]!);
};

test("FramePath's three modes: a key starts Plain (no handles); Break lets out differ from in, Mirror links them, Plain puts both to 0 and hides the handles", async ({ page }) => {
  await open(page, "hips");
  const panel = panelOf(page);
  await goToKey(page, 2);
  const speedIn = panel.getByRole("spinbutton", { name: "Speed in" }), speedOut = panel.getByRole("spinbutton", { name: "Speed out" });
  const handles = () => page.evaluate(() => (window as unknown as { boneburst: { motionPath: { speedHandles: readonly { i: number }[] } } }).boneburst.motionPath.speedHandles.filter((h) => h.i === 2).length);
  await expect(panel.getByRole("button", { name: "Plain", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(handles).toBe(0);
  await panel.getByRole("button", { name: "Break", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Break", exact: true })).toHaveAttribute("aria-pressed", "true");
  await speedOut.fill("1.5");
  await speedOut.press("Enter");
  await expect(speedOut).toHaveValue("1.5");
  await expect(speedIn).toHaveValue("0");
  await panel.getByRole("button", { name: "Mirror", exact: true }).click();
  await expect(speedIn).toHaveValue("1.5");
  await expect(panel.getByRole("button", { name: "Mirror", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(handles).toBe(2);
  await panel.getByRole("button", { name: "Plain", exact: true }).click();
  await expect(speedIn).toHaveValue("0");
  await expect(speedOut).toHaveValue("0");
  await expect.poll(handles).toBe(0);
});

test("FramePath: Shift + click deletes a key, on the speed graph's point and on the strip's diamond", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  await open(page, "hips");
  const panel = panelOf(page);
  const before = (await hipsKeys(page)).length;
  const click = async (where: "graph" | "strip", i: number): Promise<void> => {
    const canvas = panel.locator(where === "graph" ? ".lp-speed-canvas" : ".lp-keystrip"), box = (await canvas.boundingBox())!;
    const p = await page.evaluate(([w, n]) => { const m = (window as unknown as Points).boneburst.motionPath; return w === "graph" ? m.speedPoints.find((q) => q.i === n)! : { ...m.stripPoints.find((q) => q.i === n)!, y: 35 }; }, [where, i] as const);
    await page.keyboard.down("Shift");
    await page.mouse.move(box.x + p.x, box.y + p.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.keyboard.up("Shift");
  };
  await click("graph", 3);
  await expect.poll(async () => (await hipsKeys(page)).length).toBe(before - 1);
  await click("strip", 2);
  await expect.poll(async () => (await hipsKeys(page)).length).toBe(before - 2);
});

test("FramePath's modes on the picture: Mirror gives a key two handles in line and curves its spans; dragging a tip bends the path; Plain makes it straight again", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  await open(page, "hips");
  const panel = panelOf(page);
  await goToKey(page, 3);
  type Tips = { boneburst: { motionPath: { keyHandlePoints: readonly { i: number; side: string; x: number; y: number }[] } } };
  const tips = () => page.evaluate(() => (window as unknown as Tips).boneburst.motionPath.keyHandlePoints.filter((p) => p.i === 3));
  const curves = () => page.evaluate(() => ((window as unknown as Live).boneburst.session.doc.animations[0]!.bones!.find((b) => b.name === "hips")!.timelines.find((t) => t.name === "translate")!.keys as { curve?: unknown }[]).slice(2, 4).map((k) => Array.isArray(k.curve)));
  await expect.poll(async () => (await tips()).length).toBe(0);
  await panel.getByRole("button", { name: "Mirror", exact: true }).click();
  await expect.poll(async () => (await tips()).length).toBe(2);
  // Drag the out handle's tip up on the picture: the path bends, and in Mirror the in handle turns with it.
  const before = await tips(), out = before.find((p) => p.side === "out")!, box = (await panel.locator(".lp-body canvas").boundingBox())!;
  await page.mouse.move(box.x + out.x, box.y + out.y);
  await page.mouse.down();
  await page.mouse.move(box.x + out.x + 5, box.y + out.y - 40, { steps: 4 });
  await page.mouse.up();
  await expect.poll(curves).toEqual([true, true]);
  const after = await tips(), ain = after.find((p) => p.side === "in")!, bin = before.find((p) => p.side === "in")!;
  expect(Math.hypot(ain.x - bin.x, ain.y - bin.y)).toBeGreaterThan(5);
  await expect(panel.getByRole("button", { name: "Mirror", exact: true })).toHaveAttribute("aria-pressed", "true");
  await panel.getByRole("button", { name: "Plain", exact: true }).click();
  await expect.poll(curves).toEqual([false, false]);
  await expect.poll(async () => (await tips()).length).toBe(0);
});
