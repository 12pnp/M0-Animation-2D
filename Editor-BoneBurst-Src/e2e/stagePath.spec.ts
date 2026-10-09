import { expect, type Page, test } from "@playwright/test";

/** The speed graph's Stage toggle and path colour (docs/STAGE-PATH-PLAN.md): the Stage draws the bone's path in the colour, the speed curve takes it, both are kept. */

type Live = { boneburst: { session: { select(s: unknown): void }; motionPath: { stageTrail(): { trail: { frames: number; joint: Float64Array }; colour: string } | null } } };

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^FramePath$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
}

const shown = (page: Page) => page.evaluate(() => { const t = (window as unknown as Live).boneburst.motionPath.stageTrail(); return t && { frames: t.trail.frames, colour: t.colour }; });

test("Stage shows the bone's path on the Stage in the swatch's colour; the speed curve takes the colour; both are kept; off, the graph keeps the colour", async ({ page }) => {
  await open(page);
  const panel = page.locator(".panel.motion-path"), toggle = panel.getByRole("button", { name: "Path on Stage" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  expect(await shown(page)).toBeNull();
  await toggle.click();
  await expect(panel.getByRole("button", { name: "Path on Stage" })).toHaveAttribute("aria-pressed", "true");
  const on = await shown(page);
  expect(on?.frames).toBeGreaterThan(1);
  expect(on?.colour).toBe("#ff9f1c");
  // A new colour: the trail and the swatch take it.
  await panel.getByRole("button", { name: "Path colour" }).click();
  const hex = page.getByRole("textbox", { name: "Hex colour" });
  await hex.fill("#0000ff");
  await hex.press("Enter");
  await page.locator(".colour-popup").getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => (await shown(page))?.colour).toBe("#0000ff");
  await expect(panel.getByRole("button", { name: "Path colour" })).toHaveCSS("background-color", "rgb(0, 0, 255)");
  // The speed curve is drawn in it: some of the graph's pixels are that colour.
  const blue = () => page.locator(".lp-speed-canvas").evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! < 6 && d[i + 1]! < 6 && d[i + 2]! > 249) n++;
    return n;
  });
  await expect.poll(blue).toBeGreaterThan(20);
  // FramePath's path line and dots in the picture take it too (FRAMEPATH-SPEED-PLAN step 17).
  const blueInPicture = () => page.locator(".lp-body canvas").evaluate((c: HTMLCanvasElement) => {
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! < 6 && d[i + 1]! < 6 && d[i + 2]! > 249) n++;
    return n;
  });
  await expect.poll(blueInPicture).toBeGreaterThan(20);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("boneburst.motionPath.stagePath") ?? "null"))).toEqual({ on: true, colour: "#0000ff" });
  await panel.getByRole("button", { name: "Path on Stage" }).click();
  expect(await shown(page)).toBeNull();
  await expect.poll(blue).toBeGreaterThan(20);
});
