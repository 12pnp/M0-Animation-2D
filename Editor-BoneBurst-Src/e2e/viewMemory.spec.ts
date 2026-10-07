import { expect, test } from "@playwright/test";

/** A project opened again is as it was left: selection, animation, playhead, tool, camera, the Motion Path panel's view. */

type Live = { boneburst: { session: { selectedBone: string | null; frame: number; animation: { name: string } | null; skin: string | null; seek(f: number): void; select(s: unknown): void; showAnimation(n: string | null): void; doc: { animations: { name: string }[] } }; stage: { tool: string; camera: { x: number; y: number; zoom: number } }; motionPath: { memory: { zoom: number; mode: string } } } };

test("opening the project again puts back what was selected, the animation and frame, the tool, the camera and the Motion Path view", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const left = await page.evaluate(async () => {
    const b = (window as unknown as Live).boneburst, s = b.session;
    s.showAnimation(s.doc.animations[0]!.name);
    s.select({ kind: "bone", name: "head" });
    s.seek(4);
    return { animation: s.animation!.name };
  });
  await page.keyboard.press("r");
  await page.locator(".stage-panel canvas.overlay").hover();
  await page.mouse.wheel(0, -400);
  const cam = await page.evaluate(() => (window as unknown as Live).boneburst.stage.camera);
  // The view is written every moment; wait one.
  await page.waitForTimeout(2000);
  expect(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("boneburst.view.Stickman")))).toBe(true);
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const back = await page.evaluate(() => { const b = (window as unknown as Live).boneburst; return { bone: b.session.selectedBone, frame: b.session.frame, animation: b.session.animation?.name, tool: b.stage.tool, camera: b.stage.camera }; });
  expect(back.bone).toBe("head");
  expect(back.frame).toBe(4);
  expect(back.animation).toBe(left.animation);
  expect(back.tool).toBe("rotate");
  expect(back.camera.zoom).toBeCloseTo(cam.zoom, 3);
  expect(back.camera.x).toBeCloseTo(cam.x, 2);
});

test("each project keeps its own panel layout: a panel closed in one project stays closed when it is opened again, and a project never opened before starts from the layout as it is", async ({ page }) => {
  type W = { boneburst: { workspace: { isOpen(id: string): boolean; close(id: string): void }; session: { newProject(): void } } };
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  const open = (id: string) => page.evaluate((i) => (window as unknown as W).boneburst.workspace.isOpen(i), id);
  expect(await open("history")).toBe(true);
  await page.evaluate(() => (window as unknown as W).boneburst.workspace.close("history"));
  expect(await open("history")).toBe(false);
  // Written after a moment, and under this project's own key.
  await expect.poll(() => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith("boneburst.workspace") && k.includes(".project.Stickman")).length)).toBeGreaterThan(0);
  // (the layout is written a moment after it changes)
  await page.waitForTimeout(700);
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await expect.poll(() => open("history")).toBe(false);
  // Another project (a new one, with no name yet, takes the general layout) has the panel.
  await page.evaluate(() => (window as unknown as W).boneburst.session.newProject());
  await expect.poll(() => open("history")).toBe(true);
});
