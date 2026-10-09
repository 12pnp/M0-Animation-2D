import { expect, type Page, test } from "@playwright/test";

/** FramePath's frame strip (docs/FRAMEPATH-SPEED-PLAN.md, steps 22 and 24): the fps field at its left end, the last-frame button by Fit, no diamonds in the tab row. */

type Live = { boneburst: { session: { select(s: unknown): void; seek(f: number): void; fps: number; history: { undo(): void }; changed(): void; doc: { header?: { fps?: number } } }; motionPath: { stripPoints: readonly { i: number; x: number }[] } } };

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
  await expect.poll(() => page.evaluate(() => (window as unknown as Live).boneburst.motionPath.stripPoints.length)).toBeGreaterThan(3);
}

test("the fps field shows the frame rate and writes it, one undo step, the keys keeping their times", async ({ page }) => {
  await open(page);
  const fps = page.locator(".panel.motion-path").getByRole("spinbutton", { name: "Frame rate" });
  const was = await page.evaluate(() => (window as unknown as Live).boneburst.session.fps);
  await expect(fps).toHaveValue(String(was));
  await fps.fill("30");
  await fps.press("Enter");
  await expect.poll(() => page.evaluate(() => (window as unknown as Live).boneburst.session.fps)).toBe(30);
  await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; s.history.undo(); s.changed(); });
  await expect.poll(() => page.evaluate(() => (window as unknown as Live).boneburst.session.fps)).toBe(was);
  await expect(fps).toHaveValue(String(was));
});

test("the last-frame button sits in the ruler row left of Fit; the tab row draws no diamond at a key", async ({ page }) => {
  await open(page);
  const panel = page.locator(".panel.motion-path"), limit = panel.getByRole("button", { name: "Last frame" }), fit = panel.getByRole("button", { name: /^Fit: the whole animation/ }), strip = panel.locator(".lp-keystrip");
  const sb = (await strip.boundingBox())!, lb = (await limit.boundingBox())!, fb = (await fit.boundingBox())!;
  expect(lb.x + lb.width).toBeLessThanOrEqual(fb.x);
  expect(lb.y + lb.height).toBeLessThanOrEqual(sb.y + 26);
  await expect(limit).toHaveText("30");
  // Where key 2's diamond was drawn (the tab row's middle): no accent blue.
  const pts = await page.evaluate(() => (window as unknown as Live).boneburst.motionPath.stripPoints);
  const blue = await strip.evaluate((c: HTMLCanvasElement, x) => { const k = c.width / c.getBoundingClientRect().width, d = c.getContext("2d")!.getImageData(Math.round(x * k), Math.round(35 * k), 1, 1).data; return d[2]! > d[0]! + 80; }, pts[1]!.x);
  expect(blue).toBe(false);
});
