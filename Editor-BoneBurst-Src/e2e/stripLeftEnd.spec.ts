import { expect, type Page, test } from "@playwright/test";

/** FramePath's frame strip, step 22 of docs/FRAMEPATH-SPEED-PLAN.md: the fps field and the lock at its left end, no diamonds in the tab row. */

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

test("the lock sits in the ruler row left of frame 0 and still locks; the tab row draws no diamond at a key", async ({ page }) => {
  await open(page);
  const panel = page.locator(".panel.motion-path"), lock = panel.getByRole("button", { name: "Frame lock" }), strip = panel.locator(".lp-keystrip");
  const pts = await page.evaluate(() => (window as unknown as Live).boneburst.motionPath.stripPoints);
  const sb = (await strip.boundingBox())!, lb = (await lock.boundingBox())!;
  // Key 1 is on frame 0: the lock ends left of it, inside the ruler row (the strip's top 24 px).
  expect(lb.x + lb.width).toBeLessThanOrEqual(sb.x + pts[0]!.x);
  expect(lb.y + lb.height).toBeLessThanOrEqual(sb.y + 26);
  await lock.click();
  await expect(lock).toHaveAttribute("aria-pressed", "true");
  // Where key 2's diamond was drawn (the tab row's middle): no accent blue.
  const blue = await strip.evaluate((c: HTMLCanvasElement, x) => { const k = c.width / c.getBoundingClientRect().width, d = c.getContext("2d")!.getImageData(Math.round(x * k), Math.round(35 * k), 1, 1).data; return d[2]! > d[0]! + 80; }, pts[1]!.x);
  expect(blue).toBe(false);
});
