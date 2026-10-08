import { expect, test } from "@playwright/test";

/** The Motion Path panel (docs/MOTION-PREVIEW-PLAN.md): only the selected bone, over every frame of the animation shown. */

// FramePath's strip and speed graph sit under the picture for every bone in Animate mode: a taller window keeps the picture big enough to count its pixels.
test.use({ viewport: { width: 1280, height: 1100 } });

type Live = { boneburst: { session: { select(s: unknown): void; showAnimation(n: string | null): void; frame: number } } };

/** How many pixels of Motion Path's canvas are drawn in: not the stage background, nor its faint checkerboard, grid or axes. */
const drawnPixels = (page: import("@playwright/test").Page) => page.evaluate(() => {
  const panel = document.querySelector(".motion-path")!, cv = panel.querySelector("canvas") as HTMLCanvasElement, d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
  const bg = parseInt(getComputedStyle(panel).getPropertyValue("--stage-bg").trim().slice(1), 16), br = (bg >> 16) & 255, bgn = (bg >> 8) & 255, bb = bg & 255;
  let n = 0;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i]! - br) + Math.abs(d[i + 1]! - bgn) + Math.abs(d[i + 2]! - bb) > 90) n++;
  return n;
});

test("Motion Path shows the selected bone's path over the animation, in its parent's space; a click on a mark seeks", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  // In Animate; the panel is a tab behind Properties.
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  const panel = page.locator(".motion-path");
  await expect(panel.locator(".lp-note")).toContainText("Select a bone");
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "head" }));
  await expect(panel.locator(".lp-head > span")).toHaveText(/^head · Parent \S+$/);
  await expect(panel.locator(".lp-note")).toBeHidden();
  // The World view is gone: there is no button for it.
  await expect(panel.getByRole("button", { name: "World", exact: true })).toHaveCount(0);
  // A mark: sweep the canvas for one (the page's own pointer events); the playhead moves off frame 0.
  const moved = await page.evaluate(() => {
    const live = (window as unknown as Live).boneburst, cv = document.querySelector(".motion-path canvas")!, r = cv.getBoundingClientRect(), before = live.session.frame;
    for (let x = 6; x < r.width - 6; x += 5) {
      for (let y = 6; y < r.height - 6; y += 5) {
        cv.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: r.left + x, clientY: r.top + y, pointerId: 1 }));
        if (live.session.frame !== before) return true;
      }
    }
    return false;
  });
  expect(moved).toBe(true);
});

test("Motion Path's Image, Bone and Path buttons show and hide each layer, and are remembered", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "head_art" }));
  const panel = page.locator(".motion-path");
  for (const name of ["Image", "Bone", "Path"]) await expect(panel.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
  const drawn = () => drawnPixels(page);
  await expect.poll(drawn).toBeGreaterThan(20000);
  const all = await drawn();
  await panel.getByRole("button", { name: "Image", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Image", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect.poll(drawn).toBeLessThan(all / 2);
  // Remembered across a reload (the panel's buttons keep what was set).
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await expect(page.locator(".motion-path").getByRole("button", { name: "Image", exact: true })).toHaveAttribute("aria-pressed", "false");
});

test("Motion Path in Pose mode shows the bone and its image on the setup pose, the buttons toggle, nothing drags", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  const panel = page.locator(".motion-path");
  await expect(panel.locator(".lp-note")).toContainText("Select a bone");
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "head_art" }));
  await expect(panel.locator(".lp-head > span")).toHaveText(/^head_art · Parent \S+ · Pose$/);
  await expect(panel.locator(".lp-note")).toBeHidden();
  const drawn = () => drawnPixels(page);
  await expect.poll(drawn).toBeGreaterThan(20000);
  const all = await drawn();
  await panel.getByRole("button", { name: "Image", exact: true }).click();
  await expect.poll(drawn).toBeLessThan(all / 2);
  // A press on the canvas changes nothing: no seek, no edit.
  const state = () => page.evaluate(() => { const s = (window as unknown as { boneburst: { session: { frame: number; history: { canUndo: boolean } } } }).boneburst.session; return [s.frame, s.history.canUndo]; });
  const before = await state();
  const box = (await panel.locator(".lp-body canvas").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 4 });
  await page.mouse.up();
  expect(await state()).toEqual(before);
});

test("Onion: a button on the Timeline bar turns onion skin on and off, and Motion Path's Onion shows the bone before (red) and after (green) the playhead", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const stageOnion = page.locator(".timeline-bar").getByRole("button", { name: /^Onion skin/ });
  await expect(stageOnion).toHaveAttribute("aria-pressed", "false");
  await stageOnion.click();
  await expect(stageOnion).toHaveAttribute("aria-pressed", "true");
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("boneburst.preferences") ?? "{}").onion)).toBe(true);
  await stageOnion.click();
  await expect(stageOnion).toHaveAttribute("aria-pressed", "false");

  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; s.select({ kind: "bone", name: "arm_near_fore" }); });
  const tints = () => page.evaluate(() => {
    const cv = document.querySelector(".motion-path canvas") as HTMLCanvasElement, d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
    let red = 0, green = 0;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i]!, g = d[i + 1]!, b = d[i + 2]!;
      if (r > g + 60 && r > b + 60) red++;
      if (g > r + 40 && g > b + 40) green++;
    }
    return { red, green };
  });
  await page.evaluate(() => (window as unknown as { boneburst: { session: { seek(f: number): void } } }).boneburst.session.seek(10));
  await page.waitForTimeout(300);
  const off = await tints();
  await page.locator(".motion-path").getByRole("button", { name: "Onion", exact: true }).click();
  await expect.poll(async () => (await tints()).red).toBeGreaterThan(off.red + 50);
  // The line under the header keeps its height (a hint in it), so the picture is a little smaller and the ghosts with it.
  expect((await tints()).green).toBeGreaterThan(off.green + 20);
});

test("Motion Path zooms with the wheel, pans only with the middle button (a left drag on empty canvas does nothing), and Fit (top right) or F over it shows it whole again", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "arm_near_fore" }));
  const panel = page.locator(".motion-path"), canvas = panel.locator(".lp-body canvas");
  const picture = () => canvas.evaluate((c) => (c as HTMLCanvasElement).toDataURL());
  await expect(panel.locator(".lp-note")).toBeHidden();
  await page.waitForTimeout(300);
  const whole = await picture();
  const box = (await canvas.boundingBox())!;
  // The Fit button sits at the right end of the view bar, just above the canvas.
  const fit = await panel.locator(".lp-fit").boundingBox();
  expect(fit!.x + fit!.width).toBeGreaterThan(box.x + box.width - 14);
  expect(fit!.y).toBeGreaterThanOrEqual(box.y + box.height - 2);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(picture).not.toBe(whole);
  const zoomed = await picture();
  // A left drag on empty canvas does not pan; a middle drag does.
  await page.mouse.move(box.x + 20, box.y + box.height - 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 70, box.y + box.height - 60, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  expect(await picture()).toBe(zoomed);
  await page.mouse.move(box.x + 20, box.y + box.height - 20);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + 70, box.y + box.height - 60, { steps: 4 });
  await page.mouse.up({ button: "middle" });
  await expect.poll(picture).not.toBe(zoomed);
  await panel.locator(".lp-fit").click();
  await expect.poll(picture).toBe(whole);
  // F with the pointer over the panel fits it too (over the Stage, F is the Stage's).
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(picture).not.toBe(whole);
  await page.keyboard.press("f");
  await expect.poll(picture).toBe(whole);
});

async function openPanel(page: import("@playwright/test").Page, bone: string): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => localStorage.clear());
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate((n) => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: n }), bone);
}

const tiers = (page: import("@playwright/test").Page) => page.evaluate(() => (window as unknown as { boneburst: { motionPath: { shownTiers: { bones: string[]; images: string[] } } } }).boneburst.motionPath.shownTiers);

test("Image and Bone each have a count either side: ‹ one more tier above, › one more below, the number takes one away; the children's images show with the tiers below", async ({ page }) => {
  // The chest has no image of its own; its children (arms, head) do.
  await openPanel(page, "chest");
  const panel = page.locator(".motion-path");
  const down = panel.getByRole("button", { name: "Image: one more tier below" }), downNo = panel.getByRole("button", { name: "Image: one fewer tier below" }), downN = panel.locator('[data-count="image-b"]');
  await expect(down).toBeEnabled();
  await expect(downNo).toBeDisabled();
  const drawn = () => drawnPixels(page);
  await page.waitForTimeout(300);
  const alone = await drawn();
  await down.click();
  await expect(downN).toHaveText("1");
  await expect.poll(drawn).toBeGreaterThan(alone * 2);
  await downNo.click();
  await expect(downN).toHaveText("0");
  await expect.poll(drawn).toBeLessThan(alone * 1.5);
});

test("Bone and Image count tiers along the tree, apart from each other: the foot's parent, grandparent, and no branch beside them", async ({ page }) => {
  await openPanel(page, "shin_near");
  const panel = page.locator(".motion-path");
  expect(await tiers(page)).toEqual({ bones: ["shin_near"], images: ["shin_near"] });
  await panel.getByRole("button", { name: "Bone: one more tier above" }).click();
  await expect.poll(() => tiers(page)).toEqual({ bones: ["leg_near_shin", "shin_near"], images: ["shin_near"] });
  await panel.getByRole("button", { name: "Bone: one more tier above" }).click();
  await panel.getByRole("button", { name: "Image: one more tier above" }).click();
  await expect.poll(() => tiers(page)).toEqual({ bones: ["leg_near_thigh", "leg_near_shin", "shin_near"], images: ["leg_near_shin", "shin_near"] });
  // The number takes one away.
  await panel.getByRole("button", { name: "Bone: one fewer tier above" }).click();
  await expect.poll(() => tiers(page)).toEqual({ bones: ["leg_near_shin", "shin_near"], images: ["leg_near_shin", "shin_near"] });
  // Held at the root: the more button goes dead when every tier shows, and the counts are remembered.
  const fewer = panel.locator('[data-count="bone-a"]');
  for (const n of ["2", "3", "4"]) { await panel.getByRole("button", { name: "Bone: one more tier above" }).click(); await expect(fewer).toHaveText(n); }
  await expect(panel.getByRole("button", { name: "Bone: one more tier above" })).toBeDisabled();
  expect((await tiers(page)).bones[0]).toBe("root");
  expect(await page.evaluate(() => localStorage.getItem("boneburst.motionPath.tiers"))).toContain('"image":{"a":1');
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "shin_near" }));
  expect((await tiers(page)).images).toEqual(["leg_near_shin", "shin_near"]);
});

test("a panel saved with Parent bone and Children on opens with all the tiers above and below", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("boneburst.motionPath.layers", JSON.stringify({ parentBone: true, children: true })); });
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "chest" }));
  const t = await tiers(page);
  expect(t.bones[0]).toBe("root");
  expect(t.bones).toContain("head");
  expect(t.images).toEqual(expect.arrayContaining(["head"]));
});

test("Onion has a count of frames before and after, in the panel", async ({ page }) => {
  await openPanel(page, "head");
  const panel = page.locator(".motion-path"), before = panel.locator('[data-count="onion-a"]'), after = panel.locator('[data-count="onion-b"]');
  await expect(before).toHaveText("2");
  await expect(after).toHaveText("2");
  await panel.getByRole("button", { name: "Onion: one more frame before" }).click();
  await expect(before).toHaveText("3");
  await panel.getByRole("button", { name: "Onion: one fewer frame after" }).click();
  await expect(after).toHaveText("1");
  expect(await page.evaluate(() => localStorage.getItem("boneburst.motionPath.tiers"))).toContain('"onion":{"a":3,"b":1}');
});

test("Motion Path has the Stage's backdrop: the stage background, checkerboard, grid and centre axes, from the same settings", async ({ page }) => {
  const colours = () => page.evaluate(() => {
    const cv = document.querySelector(".motion-path canvas") as HTMLCanvasElement, d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data, seen = new Set<string>();
    for (let y = 0; y < cv.height; y += 7) for (let x = 0; x < cv.width; x += 7) { const i = (y * cv.width + x) * 4; seen.add(`${d[i]},${d[i + 1]},${d[i + 2]},${d[i + 3]}`); }
    return { seen: seen.size, corner: [...d.slice((cv.height - 4) * cv.width * 4 + (cv.width - 4) * 4, (cv.height - 4) * cv.width * 4 + (cv.width - 4) * 4 + 3)], stage: getComputedStyle(document.querySelector(".motion-path")!).getPropertyValue("--stage-bg").trim() };
  });
  const open = async (prefs: object) => {
    await page.goto("/");
    await page.evaluate((p) => localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, ...p })), prefs);
    await page.reload();
    await page.getByRole("button", { name: "Open the stickman fixture" }).click();
    await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
    await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
    await page.waitForTimeout(400);
  };
  // Everything off: the stage background alone, one colour.
  await open({ checker: false, axes: false, grid: false });
  const plain = await colours();
  expect(plain.seen).toBe(1);
  const bg = parseInt(plain.stage.slice(1), 16);
  expect(plain.corner).toEqual([(bg >> 16) & 255, (bg >> 8) & 255, bg & 255]);
  // The Stage's defaults (checkerboard, centre axes): more than one colour on the canvas.
  await open({});
  expect((await colours()).seen).toBeGreaterThan(1);
  // The grid, from its setting.
  await open({ checker: false, axes: false, grid: true, gridSize: 10 });
  expect((await colours()).seen).toBeGreaterThan(1);
});

