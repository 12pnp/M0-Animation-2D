import { expect, type Page, test } from "@playwright/test";

/** FramePath's strip (docs/FRAMEPATH-SPEED-PLAN.md, step 15): the fit icon at its right end, and the frame lock: the playhead held to the animation, Q / W wrapping round. */

type Live = { boneburst: { session: { select(s: unknown): void; seek(f: number): void; frame: number; fps: number; animation: unknown; length(a: unknown): number }; motionPath: { speedPoints: readonly { i: number; x: number; y: number }[] } } };

async function open(page: Page): Promise<number> {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  return page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; return Math.round(s.length(s.animation) * s.fps); });
}

const frame = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.frame);
const seek = (page: Page, f: number) => page.evaluate((n) => (window as unknown as Live).boneburst.session.seek(n), f);
/** Q or W with nothing focused, as the shortcuts take them. */
const press = async (page: Page, key: "q" | "w") => { await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); await page.keyboard.press(key); };

test("the frame lock holds the playhead to the animation and makes Q / W wrap; off, they go past the end as before", async ({ page }) => {
  const last = await open(page);
  expect(last).toBeGreaterThan(2);
  const lock = page.locator(".panel.motion-path").getByRole("button", { name: "Frame lock" });
  await expect(lock).toHaveAttribute("aria-pressed", "false");
  await seek(page, last);
  await press(page, "w");
  expect(await frame(page)).toBe(last + 1);
  // On: the playhead past the end comes back to the last frame.
  await lock.click();
  await expect(lock).toHaveAttribute("aria-pressed", "true");
  expect(await frame(page)).toBe(last);
  await press(page, "w");
  expect(await frame(page)).toBe(0);
  await press(page, "q");
  expect(await frame(page)).toBe(last);
  await press(page, "q");
  expect(await frame(page)).toBe(last - 1);
  await seek(page, last + 10);
  expect(await frame(page)).toBe(last);
  // An edit that shortens the animation (its keys after half a second dropped) brings a locked playhead back to the new end.
  await seek(page, last);
  const shorter = await page.evaluate(() => {
    type Doc = { animations: { bones?: { timelines: { keys: { time?: number }[] }[] }[]; slots?: unknown; [k: string]: unknown }[] };
    const s = (window as unknown as { boneburst: { session: { history: { apply(l: string, e: (d: Doc) => Doc): void }; changed(): void; frame: number; fps: number; animation: unknown; length(a: unknown): number } } }).boneburst.session;
    s.history.apply("Shorten", (d) => {
      const out = structuredClone(d), a = out.animations[0]! as Record<string, unknown>;
      // Every key list in the animation, however deep (bones, slots, deforms, draw order): its keys after half a second dropped.
      const walk = (o: unknown): void => {
        if (Array.isArray(o)) { o.forEach(walk); return; }
        if (!o || typeof o !== "object" || Object.getPrototypeOf(o) !== Object.prototype) return;
        const r = o as Record<string, unknown>;
        for (const list of ["keys", "drawOrder"]) if (Array.isArray(r[list])) r[list] = (r[list] as { time?: number }[]).filter((k) => (k.time ?? 0) <= 0.5);
        Object.values(r).forEach(walk);
      };
      walk(a);
      return out;
    });
    s.changed();
    return Math.round(s.length(s.animation) * s.fps);
  });
  expect(shorter).toBeLessThan(last);
  expect(await frame(page)).toBe(shorter);
  // Kept per browser.
  expect(await page.evaluate(() => localStorage.getItem("boneburst.frameLock"))).toBe("1");
  await lock.click();
  await expect(lock).toHaveAttribute("aria-pressed", "false");
  await press(page, "w");
  expect(await frame(page)).toBe(shorter + 1);
});

test("Fit is an icon at the strip's right end: after Node zooms into one span, it shows the whole animation again", async ({ page }) => {
  await open(page);
  const panel = page.locator(".panel.motion-path");
  await expect(panel.locator(".lp-speed-bar").getByRole("button", { name: "Fit", exact: true })).toHaveCount(0);
  const points = () => page.evaluate(() => (window as unknown as Live).boneburst.motionPath.speedPoints.map((p) => p.x));
  await expect.poll(async () => (await points()).length).toBeGreaterThan(3);
  const whole = await points();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.seek(0));
  await panel.getByRole("button", { name: "Node", exact: true }).click();
  await expect.poll(async () => (await points())[1]! - (await points())[0]!).toBeGreaterThan((whole[1]! - whole[0]!) * 2);
  await panel.getByRole("button", { name: /^Fit: the whole animation/ }).click();
  await expect.poll(points).toEqual(whole);
});
