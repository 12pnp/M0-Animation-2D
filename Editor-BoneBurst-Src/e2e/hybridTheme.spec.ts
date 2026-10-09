import { expect, test } from "@playwright/test";

/** The Hybrid theme (docs/HYBRID-THEME-PLAN.md): the editor dark, the Timeline's graph and Motion Path's speed graph light gray. */

test("Hybrid keeps the editor dark and paints both graphs light gray; Dark paints them in the panel colour", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.emulateMedia({ colorScheme: "light" });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^FramePath$/ }).click();
  const choose = async (label: string) => {
    await page.getByRole("button", { name: /^Preferences/ }).click();
    await page.getByRole("combobox", { name: "Theme" }).selectOption({ label });
    await page.keyboard.press("Escape");
  };
  await choose("Hybrid");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--panel").trim())).toBe("#2d2d2d");
  await page.evaluate(() => (window as unknown as { boneburst: { session: { select(s: unknown): void } } }).boneburst.session.select({ kind: "bone", name: "hips" }));
  const at = (sel: string, x: number, y: number) => page.locator(sel).first().evaluate((c: HTMLCanvasElement, [px, py]) => Array.from(c.getContext("2d")!.getImageData(px!, py!, 1, 1).data.slice(0, 3)), [x, y] as const);
  // The speed graph's corner, and a point low in the Timeline's graph inside the animation (past its end is shaded).
  const speed = () => at(".lp-speed-canvas", 3, 3);
  const timeline = () => page.locator(".timeline-track canvas").first().evaluate((c: HTMLCanvasElement) => Array.from(c.getContext("2d")!.getImageData(Math.floor(c.width * 0.12), c.height - 6, 1, 1).data.slice(0, 3)));
  await expect.poll(speed).toEqual([211, 211, 211]);
  await expect.poll(timeline).toEqual([211, 211, 211]);
  await choose("Dark");
  await expect.poll(speed).toEqual([45, 45, 45]);
  await expect.poll(timeline).toEqual([45, 45, 45]);
});
