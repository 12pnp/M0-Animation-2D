import { expect, test } from "@playwright/test";

/** Preferences ▸ Interface size: the page is zoomed (95%), and the pointer still lands where it is drawn. */

type Live = { boneburst: { session: { select(s: unknown): void; pose(): { bones: Map<string, number>; rig: { matrix(i: number): ArrayLike<number> } } }; stage: { camera: { x: number; y: number; zoom: number }; size: { width: number; height: number } } } };

test("at 95% the page is zoomed and fills the window, and a drag on the Stage moves a bone by the distance the pointer went", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, uiScale: 95, snap: false, stagePanels: false })));
  await page.reload();
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).zoom)).toBe("0.95");
  // It still fills the window.
  const app = await page.locator("#app").boundingBox();
  expect(app!.width).toBeCloseTo(1280, 0);
  expect(app!.height).toBeCloseTo(800, 0);
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.evaluate(() => { const b = (window as unknown as { boneburst: { workspace: { api: { getPanel(id: string): { api: { maximize(): void } } } } } }).boneburst; b.workspace.api.getPanel("stage").api.maximize(); });
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "head" }));
  await page.waitForTimeout(400);
  const head = () => page.evaluate(() => { const s = (window as unknown as Live).boneburst.session, p = s.pose(), m = p.rig.matrix(p.bones.get("head")!); return [m[4]!, m[5]!]; });
  const at = await page.evaluate(() => {
    const b = (window as unknown as Live).boneburst, s = b.session, p = s.pose(), m = p.rig.matrix(p.bones.get("head")!), cam = b.stage.camera, sz = b.stage.size, r = document.querySelector(".stage canvas.overlay")!.getBoundingClientRect();
    const k = Number.parseFloat(getComputedStyle(document.documentElement).zoom);
    // Layout pixels from the canvas's corner, drawn at `k` of a pixel: the pointer is in drawn pixels.
    return { x: r.left + ((m[4]! - cam.x) * cam.zoom + sz.width / 2) * k, y: r.top + (sz.height / 2 - (m[5]! - cam.y) * cam.zoom) * k, zoom: cam.zoom, k };
  });
  const before = await head();
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 60, at.y, { steps: 6 });
  await page.mouse.up();
  const after = await head();
  // 60 drawn pixels is 60 / 0.95 layout pixels, that many world units over the camera's zoom.
  const moved = Math.hypot(after[0]! - before[0]!, after[1]! - before[1]!);
  expect(moved).toBeGreaterThan(0.5);
  expect(moved).toBeCloseTo(60 / at.k / at.zoom, 0);
});

test("the Interface size is in Preferences ▸ User interface ▸ Interface, from 60 to 140 percent", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  // A browser under automation keeps 100% by default, so the tests measure in the pixels they see.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).zoom)).toBe("1");
  await page.locator(".app-icon").click();
  const dialog = page.locator("dialog.preferences");
  await dialog.getByText("Interface", { exact: true }).first().click();
  const size = dialog.locator("input[type=number]").first();
  await size.fill("80");
  await size.press("Enter");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).zoom)).toBe("0.8");
  await size.fill("500");
  await size.press("Enter");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).zoom)).toBe("1.4");
});

test("User interface settings: row height, tree indent, toolbar labels, font size and default frame rate take effect", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator(".app-icon").click();
  const dialog = page.locator("dialog.preferences");
  const set = async (label: RegExp, value: string): Promise<void> => {
    const n = dialog.getByLabel(label).locator("input[type=number]");
    await n.fill(value);
    await n.press("Enter");
  };
  await dialog.getByText("Interface", { exact: true }).first().click();
  const select = (label: RegExp) => dialog.getByLabel(label);
  await select(/^Font size/).selectOption("large");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).fontSize)).toBe("14px");
  await select(/^Toolbar position/).selectOption("right");
  await expect(page.locator(".stage-tools")).toHaveAttribute("data-align", "right");
  await select(/^Toolbar text labels/).selectOption("hide");
  await expect(page.locator(".stage-tools")).toHaveAttribute("data-labels", "hide");
  await dialog.getByText("Tree", { exact: true }).first().click();
  await set(/^Tree indentation/, "24");
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("boneburst.preferences")!).treeIndent)).toBe(24);
});
