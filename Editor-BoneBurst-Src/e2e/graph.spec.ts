import { expect, type Page, test } from "@playwright/test";

/**
 * The curve graph (E6-PLAN step 4g; the Timeline since docs/TIMELINE-GRAPH-PLAN.md): shows the selected bone's channels; a
 * straight interval's handle dragged makes it a curve; a key dragged up raises its value; one
 * undo each.
 */

type Live = { boneburst: { session: any } };

/** Where the graph draws `channel`'s key `i` and the first handle of its interval `i`, on the page. */
const geometry = (page: Page, label: string, i: number) => page.evaluate(async ([lab, k]) => {
  // The editor's own modules, from the dev server.
  const graphUrl = "/src/ui/timeline/graph.ts", timelinesUrl = "/src/model/timelines.ts";
  const g: any = await import(/* @vite-ignore */ graphUrl), tl: any = await import(/* @vite-ignore */ timelinesUrl);
  const s = (window as unknown as Live).boneburst.session, a = s.animation;
  const chs = g.channelsOf(tl.keyLists(a).filter((l: any) => l.path.section === "bones" && l.path.owner === "hips"));
  const ch = chs.find((c: any) => c.label === lab)!;
  const canvas = document.querySelector(".timeline-track canvas") as HTMLCanvasElement, box = canvas.getBoundingClientRect();
  const height = Math.max(24 + 22 + 60, (document.querySelector(".timeline-body") as HTMLElement).clientHeight), top = 24 + 22 + 14, bottom = Math.max(24 + 22 + 44, height - 10), fit = g.fitValues(chs);
  const x = (t: number) => box.left + (t * s.fps + 0.5) * 12, y = (v: number) => box.top + g.valueY(fit, top, bottom, v);
  const key = ch.keys[k], iv = g.intervals(ch)[k]!;
  return {
    key: { x: x(tl.keyTime(key)), y: y(tl.channelValues(ch.path, key, "start")[ch.c]) },
    handle: { x: x(iv.h[0]), y: y(iv.h[1]), value: iv.h[1] as number },
    value: tl.channelValues(ch.path, key, "start")[ch.c] as number,
    kind: iv.kind,
  };
}, [label, i] as const);

const rotateKey = (page: Page, i: number) => page.evaluate((k) => {
  const a = (window as unknown as Live).boneburst.session.animation;
  return a.bones.find((g: any) => g.name === "hips").timelines.find((t: any) => t.name === "rotate").keys[k];
}, i);

test("Timeline graph: the selected bone's channels; a handle dragged makes a curve; a key dragged up raises its value; one undo each", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".timeline select").first().selectOption("run");
  await page.evaluate(() => (window as unknown as Live).boneburst.session.selectBone("hips"));
  await expect(page.locator(".timeline-labels .channel", { hasText: "hips · rotate" })).toBeVisible();

  // A straight interval's first handle, dragged up: the interval is a curve now.
  const before = await geometry(page, "hips · rotate", 0);
  expect(before.kind).toBe("linear");
  await page.mouse.move(before.handle.x, before.handle.y);
  await page.mouse.down();
  await page.mouse.move(before.handle.x, before.handle.y - 25, { steps: 4 });
  await page.mouse.up();
  const curve = (await rotateKey(page, 0)).curve as number[];
  expect(Array.isArray(curve)).toBe(true);
  // Its first handle where it was let go: higher than the straight line's third.
  expect(curve[1]!).toBeGreaterThan(before.handle.value + 0.5);
  expect((await geometry(page, "hips · rotate", 0)).kind).toBe("bezier");
  await page.keyboard.press("ControlOrMeta+z");
  expect((await rotateKey(page, 0)).curve).toBeUndefined();

  // The second key dragged up: a larger value; one undo back.
  const k = await geometry(page, "hips · rotate", 1);
  await page.mouse.move(k.key.x, k.key.y);
  await page.mouse.down();
  await page.mouse.move(k.key.x, k.key.y - 20, { steps: 4 });
  await page.mouse.up();
  const raised = (await rotateKey(page, 1)).value ?? 0;
  expect(raised).toBeGreaterThan(k.value + 0.5);
  // Straight up: the key stays on its frame.
  expect(Math.round(((await rotateKey(page, 1)).time ?? 0) * 24)).toBe(2);
  await page.keyboard.press("ControlOrMeta+z");
  expect((await rotateKey(page, 1)).value ?? 0).toBeCloseTo(k.value, 6);
});

test("Timeline graph: a click on a key selects it, Shift adds another, Stepped acts on them, Delete removes them; one undo each", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".timeline select").first().selectOption("run");
  await page.evaluate(() => (window as unknown as Live).boneburst.session.selectBone("hips"));
  await expect(page.locator(".timeline-labels .channel", { hasText: "hips · rotate" })).toBeVisible();
  const count = () => page.evaluate(() => (window as unknown as Live).boneburst.session.animation.bones.find((g: any) => g.name === "hips").timelines.find((t: any) => t.name === "rotate").keys.length);
  const n = await count();
  const k1 = await geometry(page, "hips · rotate", 1), k2 = await geometry(page, "hips · rotate", 2);
  // Click the second key; Shift-click the third: both selected, so Stepped sets their curves.
  await page.mouse.click(k1.key.x, k1.key.y);
  await page.keyboard.down("Shift");
  await page.mouse.click(k2.key.x, k2.key.y);
  await page.keyboard.up("Shift");
  await page.getByRole("button", { name: "Stepped", exact: true }).click();
  await expect.poll(async () => (await rotateKey(page, 1)).curve).toBe("stepped");
  expect((await rotateKey(page, 2)).curve).toBe("stepped");
  expect((await rotateKey(page, 0)).curve).toBeUndefined();
  // Delete removes the two selected keys; one undo gives them back.
  await page.keyboard.press("Delete");
  await expect.poll(count).toBe(n - 2);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(count).toBe(n);
});
