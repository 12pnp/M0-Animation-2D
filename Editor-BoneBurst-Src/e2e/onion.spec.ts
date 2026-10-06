import { expect, type Page, test } from "@playwright/test";
import { decodePng } from "../src/io/png";

/**
 * Onion skin (E6-PLAN step 4d): View ▸ Onion Skin draws the poses before (red) and after (green)
 * the playhead behind the skeleton; off, the stage is as it was.
 */

type Live = { boneburst: { session: { seek(f: number): void } } };

/** The WebGL canvas alone (the bones' overlay hidden), as pixels. */
async function stagePixels(page: Page): Promise<{ width: number; pixels: Uint8ClampedArray }> {
  const overlay = page.locator(".stage canvas.overlay");
  await overlay.evaluate((el) => { (el as HTMLElement).style.visibility = "hidden"; });
  const png = await page.locator(".stage canvas:not(.overlay)").screenshot();
  await overlay.evaluate((el) => { (el as HTMLElement).style.visibility = ""; });
  return decodePng(new Uint8Array(png));
}

/** Pixels clearly red (past ghosts) and clearly green (future ones). */
function tinted(img: { pixels: Uint8ClampedArray }): { red: number; green: number } {
  let red = 0, green = 0;
  for (let i = 0; i < img.pixels.length; i += 4) {
    const r = img.pixels[i]!, g = img.pixels[i + 1]!, b = img.pixels[i + 2]!;
    if (r > g + 40 && r > b + 40) red++;
    if (g > r + 30 && g > b + 20) green++;
  }
  return { red, green };
}

test("View ▸ Onion Skin: ghosts before (red) and after (green) behind the skeleton; off, the stage as before", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".timeline select").first().selectOption("run");
  await page.evaluate(() => (window as unknown as Live).boneburst.session.seek(8));
  await page.waitForTimeout(200);
  const off = await stagePixels(page);

  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: /Onion Skin/ }).click();
  await page.waitForTimeout(200);
  const on = await stagePixels(page);
  const before = tinted(off), after = tinted(on);
  expect(after.red).toBeGreaterThan(before.red + 200);
  expect(after.green).toBeGreaterThan(before.green + 200);

  // Off again: exactly the stage as it was.
  await page.getByRole("button", { name: "View", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: /Onion Skin/ }).click();
  await page.waitForTimeout(200);
  const again = await stagePixels(page);
  expect(Buffer.from(again.pixels).equals(Buffer.from(off.pixels))).toBe(true);
});
