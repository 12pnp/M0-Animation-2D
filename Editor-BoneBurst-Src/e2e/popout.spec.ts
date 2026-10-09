import { expect, type Page, test } from "@playwright/test";
import { decodePng } from "../src/io/png";

/**
 * Popout windows (E4-PLAN step 15): a panel opened in a new window from its tab's menu draws
 * there, with the editor's styles, and still edits the document in the main window.
 */

/** The live editor, as the dev build exposes it on `window` (src/ui/app.ts). */
type Live = { boneburst: { session: { selectedBone: string | null }; stage: { camera: { x: number; y: number; zoom: number }; tool: string } } };

async function openStickman(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
}

test("a popout takes the theme chosen in Preferences, not the system's, and follows a later change (docs/POPOUT-THEME-PLAN.md)", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openStickman(page);
  // Light chosen while the system is dark.
  await page.getByRole("button", { name: /^Preferences/ }).click();
  await page.getByRole("combobox", { name: "Theme" }).selectOption({ label: "Light" });
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.locator(".stage-panel button.mode").click();
  await page.evaluate(() => (window as unknown as { boneburst: { session: { select(s: unknown): void } } }).boneburst.session.select({ kind: "bone", name: "hips" }));
  const popup = await popOut(page, "Motion Path");
  await popup.emulateMedia({ colorScheme: "dark" });
  await expect(popup.locator("html")).toHaveAttribute("data-theme", "light");
  // The speed graph is painted in Light's panel colour (white), not the dark one.
  const corner = () => popup.locator(".lp-speed-canvas").evaluate((c: HTMLCanvasElement) => Array.from(c.getContext("2d")!.getImageData(3, 3, 1, 1).data.slice(0, 3)));
  await expect.poll(corner).toEqual([255, 255, 255]);
  // Dark chosen afterwards reaches the window, and the graph is painted again.
  await page.getByRole("button", { name: /^Preferences/ }).click();
  await page.getByRole("combobox", { name: "Theme" }).selectOption({ label: "Dark" });
  await page.keyboard.press("Escape");
  await expect(popup.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect.poll(corner).toEqual([45, 45, 45]);
});

/** Pop the panel whose tab reads `title` out into its own window. */
async function popOut(page: Page, title: string): Promise<Page> {
  await page.locator(".dv-tab", { hasText: title }).first().click({ button: "right" });
  const [popup] = await Promise.all([page.waitForEvent("popup"), page.locator(".dv-context-menu-item", { hasText: "Open in New Window" }).click()]);
  await popup.waitForLoadState();
  return popup;
}

test("the Rig panel in a new window: its rows and icons drawn, a click selects in the main window, closing brings it back", async ({ page }) => {
  await openStickman(page);
  const popup = await popOut(page, "Rig");
  const row = popup.locator(".outline .row", { hasText: "leg_near_thigh" }).first();
  await expect(row).toBeVisible();
  // The panel left the main window.
  await expect(page.locator(".outline .row")).toHaveCount(0);
  // Icons are drawn: the editor's styles reached the window (a masked, sized span).
  const icon = await row.locator(".icon").evaluate((el) => {
    const cs = el.ownerDocument.defaultView!.getComputedStyle(el);
    return { mask: cs.maskImage || cs.webkitMaskImage, width: el.getBoundingClientRect().width };
  });
  expect(icon.mask).toContain("vendor/icons/lucide/bone.svg");
  expect(icon.width).toBeGreaterThan(10);
  await row.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as Live).boneburst.session.selectedBone)).toBe("leg_near_thigh");
  await expect(row).toHaveClass(/selected/);
  await popup.close();
  await expect(page.locator(".outline .row", { hasText: "leg_near_thigh" }).first()).toBeVisible();
});

test("the Stage in a new window: WebGL draws the skeleton, a drag pans, keys reach the editor", async ({ page }) => {
  await openStickman(page);
  const popup = await popOut(page, "Stage");
  const gl = popup.locator(".stage canvas:not(.overlay)");
  // The WebGL canvas alone: an element screenshot is what is on screen there, so the overlay
  // (bones, guides, drawn by the 2D canvas over it) is hidden while it is taken.
  const glShot = async () => {
    await popup.locator(".stage canvas.overlay").evaluate((el) => { (el as HTMLElement).style.visibility = "hidden"; });
    const png = await gl.screenshot();
    await popup.locator(".stage canvas.overlay").evaluate((el) => { (el as HTMLElement).style.visibility = ""; });
    return png;
  };
  await expect(gl).toBeVisible();
  // Drawn: enough pixels differ from the most common colour (the stage background).
  await expect.poll(async () => drawnShare(await glShot()), { message: "share of the popped-out stage that is not background" }).toBeGreaterThan(0.01);
  const first = await glShot();
  const camera = () => page.evaluate(() => ({ ...(window as unknown as Live).boneburst.stage.camera }));
  const before = await camera();
  const box = (await popup.locator(".stage canvas.overlay").boundingBox())!;
  // An empty corner: a press there pans.
  await popup.mouse.move(box.x + box.width - 30, box.y + box.height - 30);
  await popup.mouse.down({ button: "right" });
  await popup.mouse.move(box.x + box.width - 130, box.y + box.height - 80, { steps: 5 });
  await popup.mouse.up({ button: "right" });
  const after = await camera();
  expect(after.x).not.toBe(before.x);
  expect(after.y).not.toBe(before.y);
  // Drawn again in the window: the panned view is a new picture, still of the skeleton (a canvas
  // moved into the window keeps its last frame, so one picture alone proves nothing).
  await expect.poll(async () => Buffer.compare(await glShot(), first) !== 0, { message: "the stage redrew after panning" }).toBe(true);
  expect(await drawnShare(await glShot())).toBeGreaterThan(0.01);
  // A key pressed in the window reaches the editor: R picks the Rotate tool.
  await popup.locator(".stage canvas.overlay").focus();
  await popup.keyboard.press("r");
  await expect.poll(() => page.evaluate(() => (window as unknown as Live).boneburst.stage.tool)).toBe("rotate");
  await popup.close();
  await expect(page.locator(".stage canvas.overlay")).toBeVisible();
});

/** The share of a screenshot that is not its most common colour (the background). */
async function drawnShare(png: Buffer): Promise<number> {
  const shot = await decodePng(new Uint8Array(png));
  const counts = new Map<number, number>();
  for (let i = 0; i < shot.pixels.length; i += 4) {
    const c = (shot.pixels[i]! << 16) | (shot.pixels[i + 1]! << 8) | shot.pixels[i + 2]!;
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return 1 - Math.max(...counts.values()) / (shot.width * shot.height);
}
