import { expect, type Page, test } from "@playwright/test";

/** ⌘ and Shift preview a click on FramePath's picture (docs/FRAMEPATH-SPEED-PLAN.md, step 21). */

type Live = { boneburst: { session: { select(s: unknown): void; seek(f: number): void; fps: number; doc: { animations: { bones?: { name: string; timelines: { name: string; keys: { time?: number }[] }[] }[] }[] } }; motionPath: { grabPoints: { marks: number[] }; pathHoverNow: { kind: string; frame: number } | null } } };

const hover = (page: Page) => page.evaluate(() => (window as unknown as Live).boneburst.motionPath.pathHoverNow);
const mark = (page: Page, f: number) => page.evaluate((n) => (window as unknown as Live).boneburst.motionPath.grabPoints.marks.slice(n * 2, n * 2 + 2), f);
const picture = (page: Page) => page.locator(".panel.motion-path .lp-body canvas");

test("⌘ over the path previews an add, ⌘ over a key's dot its menu, Shift over it a red delete; letting go clears it", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
  await page.locator(".dv-tab", { hasText: /^FramePath$/ }).click();
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  const frames = await page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; return s.doc.animations[0]!.bones!.find((b) => b.name === "hips")!.timelines.find((t) => t.name === "translate")!.keys.map((k) => Math.round((k.time ?? 0) * s.fps)); });
  await page.evaluate((n) => (window as unknown as Live).boneburst.session.seek(n), frames[1]!);
  const key = frames[2]!;
  await expect.poll(async () => { const a = await mark(page, key); await page.waitForTimeout(50); const b = await mark(page, key); return a.length === 2 && a.every(Number.isFinite) && a[0] === b[0] && a[1] === b[1]; }).toBe(true);
  const box = (await picture(page).boundingBox())!, onKey = await mark(page, key);
  // A key's dot: ⌘ previews its menu, Shift its delete (the dot drawn red).
  await page.mouse.move(box.x + onKey[0]!, box.y + onKey[1]!);
  await page.keyboard.down("Meta");
  await expect.poll(() => hover(page)).toEqual({ kind: "menu", frame: key });
  await expect(picture(page)).toHaveCSS("cursor", "pointer");
  await page.keyboard.up("Meta");
  await expect.poll(() => hover(page)).toBeNull();
  await page.keyboard.down("Shift");
  await expect.poll(() => hover(page)).toEqual({ kind: "delete", frame: key });
  const red = () => picture(page).evaluate((c: HTMLCanvasElement, [x, y]) => { const k = c.width / c.getBoundingClientRect().width, d = c.getContext("2d")!.getImageData(Math.round(x! * k), Math.round(y! * k), 1, 1).data; return d[0]! > 180 && d[1]! < 110 && d[2]! < 110; }, onKey);
  await expect.poll(red).toBe(true);
  await page.keyboard.up("Shift");
  await expect.poll(() => hover(page)).toBeNull();
  // The path between two keys: ⌘ previews an add there.
  const mid = Math.floor((frames[1]! + frames[2]!) / 2), onPath = await mark(page, mid);
  await page.mouse.move(box.x + onPath[0]!, box.y + onPath[1]!);
  await page.keyboard.down("Meta");
  await expect.poll(async () => (await hover(page))?.kind).toBe("add");
  await expect(picture(page)).toHaveCSS("cursor", "pointer");
  await page.keyboard.up("Meta");
  await expect.poll(() => hover(page)).toBeNull();
});
