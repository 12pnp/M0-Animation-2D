import { expect, test } from "@playwright/test";

/** The Motion Path panel (docs/MOTION-PREVIEW-PLAN.md): only the selected bone, over every frame of the animation shown. */

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
  for (const name of ["Image", "Bone", "Path", "Spline"]) await expect(panel.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "true");
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
  // The path bar keeps its height on every tab now (a hint in it for a bone with no path), so the picture is a little smaller and the ghosts with it.
  expect((await tints()).green).toBeGreaterThan(off.green + 20);
});

test("Motion Path zooms with the wheel, pans only with the middle button (a left drag on empty canvas does nothing), and Fit (top right) shows it whole again", async ({ page }) => {
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
});

test("Motion Path's Children button shows every bone under the selected one, with their images", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  // The chest has no image of its own; its children (arms, head) do.
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "chest" }));
  const panel = page.locator(".motion-path"), children = panel.getByRole("button", { name: "Children", exact: true });
  await expect(children).toHaveAttribute("aria-pressed", "false");
  const drawn = () => drawnPixels(page);
  await page.waitForTimeout(300);
  const alone = await drawn();
  await children.click();
  await expect(children).toHaveAttribute("aria-pressed", "true");
  await expect.poll(drawn).toBeGreaterThan(alone * 2);
  await children.click();
  await expect(children).toHaveAttribute("aria-pressed", "false");
  await expect.poll(drawn).toBeLessThan(alone * 1.5);
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

test("Motion Path's Parent bone and Parent image buttons show the parent bone the path is relative to and the bones down to the bone, fainter and behind the bone's own; off until pressed, and remembered", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => localStorage.clear());
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "head" }));
  const panel = page.locator(".motion-path"), bone = panel.getByRole("button", { name: "Parent bone", exact: true }), image = panel.getByRole("button", { name: "Parent image", exact: true });
  await expect(bone).toHaveAttribute("aria-pressed", "false");
  await expect(image).toHaveAttribute("aria-pressed", "false");
  const drawn = () => drawnPixels(page);
  await expect.poll(drawn).toBeGreaterThan(1000);
  const before = await drawn();
  // The parent bone drawn changes the picture (and the view takes it in).
  await bone.click();
  await expect(bone).toHaveAttribute("aria-pressed", "true");
  await expect.poll(drawn).not.toBe(before);
  // (Parent image draws the pictures of the parent and the bones down to the bone; the head's parent, the chest, has none.)
  await image.click();
  await expect(image).toHaveAttribute("aria-pressed", "true");
  await image.click();
  await expect(image).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => localStorage.getItem("boneburst.motionPath.layers"))).toContain('"parentBone":true');
});

test("Motion Path's Parent buttons draw the bones from the parent down to the bone along the tree, not the whole body: hips to the foot is the one leg", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.evaluate(() => localStorage.clear());
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "shin_near" }));
  const panel = page.locator(".motion-path");
  await panel.getByRole("combobox", { name: "Parent bone" }).selectOption("hips");
  await panel.getByRole("button", { name: "Parent bone", exact: true }).click();
  const tree = () => page.evaluate(() => (window as unknown as { boneburst: { motionPath: { parentTree: string[] } } }).boneburst.motionPath.parentTree);
  await expect.poll(tree).toEqual(["hips", "leg_near_thigh", "leg_near_shin"]);
  // A nearer parent: just the bone's own parent.
  await panel.getByRole("combobox", { name: "Parent bone" }).selectOption("leg_near_shin");
  await expect.poll(tree).toEqual(["leg_near_shin"]);
});
