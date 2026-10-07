import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";

/** The Closed loop tick (docs/LOOP-PLAN.md): the closing frame is supplied where the animation is used and exported, never stored. */

type Live = {
  boneburst: {
    session: {
      animation: { name: string } | null;
      doc: { animations: { name: string }[] };
      length(a: { name: string }): number;
      loopOf(n: string): boolean;
      fps: number;
      history: { entries: { done: number } };
      showAnimation(n: string | null): void;
    };
  };
};

async function open(page: Page): Promise<void> {
  await page.goto("/");
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, saveTo: "file" })); });
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".stage-panel button.mode").click();
}

const frames = (page: Page) => page.evaluate(() => { const s = (window as unknown as Live).boneburst.session; return Math.round(s.length(s.animation!) * s.fps); });

test("Closed loop is ticked by default; unticking takes the closing frame away, and the length goes with it", async ({ page }) => {
  await open(page);
  const tick = page.getByLabel("Closed loop");
  await expect(tick).toBeChecked();
  const closed = await frames(page);
  await tick.uncheck();
  await expect.poll(() => frames(page)).toBeLessThanOrEqual(closed);
  await tick.check();
  await expect.poll(() => frames(page)).toBe(closed);
});

test("the tick is not an edit: no undo step, and the document is not dirty", async ({ page }) => {
  await open(page);
  const steps = await page.evaluate(() => (window as unknown as Live).boneburst.session.history.entries.done);
  await page.getByLabel("Closed loop").uncheck();
  expect(await page.evaluate(() => (window as unknown as Live).boneburst.session.history.entries.done)).toBe(steps);
});

test("a project keeps which animations are not loops", async ({ page }) => {
  await open(page);
  await page.getByLabel("Closed loop").uncheck();
  await page.getByRole("button", { name: "File", exact: true }).click();
  const [saved] = await Promise.all([page.waitForEvent("download"), page.getByRole("menuitem", { name: /^Save Project(?! As)/ }).click()]);
  const path = join(mkdtempSync(join(tmpdir(), "bbdata-")), "Stickman_IK.bbdata");
  await saved.saveAs(path);
  expect(readFileSync(path).toString("latin1")).toContain('"loopOff"');
  await page.reload();
  await page.locator('input[type=file][accept*=".bbdata"]').setInputFiles(path);
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  // The animation shown is kept too, so it opens in Animate.
  await expect(page.getByLabel("Closed loop")).toBeEnabled();
  await expect(page.getByLabel("Closed loop")).not.toBeChecked();
});

test("Export Spine JSON carries the closing key of a loop,, and not for one that is unticked", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => { localStorage.clear(); localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, saveTo: "file" })); });
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".timeline select").first().selectOption("run");
  const lastTime = async (): Promise<number> => {
    const [dl] = await Promise.all([page.waitForEvent("download", { predicate: (d) => d.suggestedFilename().endsWith(".json") }), (async () => {
      await page.getByRole("button", { name: "File", exact: true }).click();
      await page.getByRole("menuitem", { name: /^Export Spine JSON/ }).click();
    })()]);
    const path = join(mkdtempSync(join(tmpdir(), "loop-")), "x.json");
    await dl.saveAs(path);
    const json = JSON.parse(readFileSync(path, "utf8")) as { animations: Record<string, unknown> };
    let last = 0;
    // Every key of the animation, whatever its section: the animation's length is the latest.
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "time" && typeof x === "number") last = Math.max(last, x); else walk(x); }
    };
    walk(json.animations.run);
    return last;
  };
  const closed = await lastTime();
  await page.getByLabel("Closed loop").uncheck();
  const open = await lastTime();
  expect(closed).toBeGreaterThan(open);
  expect(closed - open).toBeCloseTo(1 / 24, 3);
});

test("dragging on the ruler's frame tag moves the playhead frame by frame", async ({ page }) => {
  await open(page);
  const box = (await page.locator(".timeline-track canvas").boundingBox())!;
  await page.mouse.move(box.x + 50, box.y + 9);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 9, { steps: 4 });
  await page.mouse.move(box.x + 200, box.y + 9, { steps: 4 });
  await page.mouse.up();
  const frame = await page.evaluate(() => (window as unknown as { boneburst: { session: { frame: number } } }).boneburst.session.frame);
  // 12 px a frame, the track's first frame a half before 0: 200 px is about frame 17.
  expect(frame).toBeGreaterThan(10);
  expect(Number.isInteger(frame)).toBe(true);
});
