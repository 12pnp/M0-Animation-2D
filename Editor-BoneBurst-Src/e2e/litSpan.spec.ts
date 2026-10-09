import { expect, test } from "@playwright/test";

/** The span at the playhead is lit on FramePath's path as on its strip (docs/FRAMEPATH-SPEED-PLAN.md, step 18). */

type Live = { boneburst: { session: { select(s: unknown): void; seek(f: number): void; fps: number; doc: { animations: { bones?: { name: string; timelines: { name: string; keys: { time?: number }[] }[] }[] }[] } }; motionPath: { grabPoints: { marks: number[] } } } };

test("the path between the keys either side of the playhead is drawn in the accent; elsewhere it is the path colour", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^Motion Path$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  // Its keys' frames; a frame halfway through the second span.
  const frames = await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; return s.doc.animations[0]!.bones!.find((b) => b.name === "hips")!.timelines.find((t) => t.name === "translate")!.keys.map((k) => Math.round((k.time ?? 0) * s.fps)); });
  const mid = Math.floor((frames[1]! + frames[2]!) / 2);
  expect(mid).toBeGreaterThan(frames[1]!);
  /** The picture's colour on the path at frame `f`: "blue" (the accent) or "orange" (the path colour), by which channel leads. */
  const hue = (f: number) => page.locator(".panel.motion-path .lp-body canvas").evaluate((c: HTMLCanvasElement, n) => {
    const m = (window as unknown as Live).boneburst.motionPath.grabPoints.marks;
    const k = c.width / c.getBoundingClientRect().width, d = c.getContext("2d")!.getImageData(Math.round(m[n * 2]! * k), Math.round(m[n * 2 + 1]! * k), 1, 1).data;
    return d[2]! > d[0]! + 60 ? "blue" : d[0]! > d[2]! + 60 ? "orange" : `other ${d[0]},${d[1]},${d[2]}`;
  }, f);
  await page.evaluate((f) => (window as unknown as Live).boneburst.session.seek(f), frames[1]!);
  await expect.poll(() => hue(mid)).toBe("blue");
  await page.evaluate((f) => (window as unknown as Live).boneburst.session.seek(f), frames[3]!);
  await expect.poll(() => hue(mid)).toBe("orange");
});
