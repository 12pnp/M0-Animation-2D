import { expect, test } from "@playwright/test";

/** Path attachments (docs/PATH-PLAN.md): make one from the path window, drag a point on the stage, type a vertex in Local or World, one undo each. */

type Live = { boneburst: { session: { select(s: unknown): void; doc: { skins: { attachments: { slot: string; entries: { key: string; attachment: { vertices: number[]; vertexCount: number } }[] }[] }[] }; history: { undo(): void; apply(l: string, e: unknown): void }; changed(): void; pathVertex: number | null; pose(): unknown }; stage: { camera: { x: number; y: number; zoom: number }; size: { width: number; height: number }; fitView(): void }; workspace: { api: { getPanel(id: string): { api: { maximize(): void } } } } } };

const vertices = (page: import("@playwright/test").Page) => page.evaluate(() => {
  const att = (window as unknown as Live).boneburst.session.doc.skins[0]!.attachments.flatMap((sl) => sl.entries).find((e) => (e.attachment as { type?: string }).type === "path");
  return att ? att.attachment.vertices.slice() : [];
});

test("a path's point dragged on the stage, typed in Local and World, undone in one step each", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, snap: false })));
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  // No path yet: select a bone, and the path window offers to make one on a new slot of it.
  expect(await vertices(page)).toEqual([]);
  await page.evaluate(() => (window as unknown as Live).boneburst.session.select({ kind: "bone", name: "hips" }));
  await expect(page.locator(".path-panel")).toBeVisible();
  await expect(page.locator(".path-panel .note")).toContainText("hips");
  await page.locator(".path-panel").getByRole("button", { name: "+ New Path" }).click();
  await expect.poll(async () => (await vertices(page)).length).toBe(12);
  await expect(page.locator(".message")).toContainText("Added the path");
  // It is selected, with its vertices to type: one undo takes the slot and the path away together.
  await expect(page.locator(".path-panel input.cell").first()).toBeVisible();
  // The stage's own size is small in this layout: the point's screen place, from the camera.
  await page.evaluate(() => { const b = (window as unknown as Live).boneburst; b.workspace.api.getPanel("stage").api.maximize(); b.stage.fitView(); });
  await page.waitForTimeout(400);
  const before = await vertices(page);
  const at = await page.evaluate(async () => {
    const b = (window as unknown as Live).boneburst, pv = await import(/* @vite-ignore */ "/src/ui/stage/" + "pathView.ts");
    const view = pv.pathView(b.session.doc as never, b.session.pose() as never, { skin: "default", slot: "hips-path", key: "path" })!;
    const cam = b.stage.camera, sz = b.stage.size, r = document.querySelector(".stage canvas.overlay")!.getBoundingClientRect();
    return { x: r.left + (view.world[8]! - cam.x) * cam.zoom + sz.width / 2, y: r.top + sz.height / 2 - (view.world[9]! - cam.y) * cam.zoom };
  });
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 40, at.y - 30, { steps: 5 });
  await page.mouse.up();
  const dragged = await vertices(page);
  expect(dragged.slice(6, 12)).not.toEqual(before.slice(6, 12));
  // The point's two handles went with it, by the same amount.
  expect(dragged[6]! - before[6]!).toBeCloseTo(dragged[8]! - before[8]!, 2);
  expect(dragged[10]! - before[10]!).toBeCloseTo(dragged[8]! - before[8]!, 2);
  // One undo for the whole drag.
  await page.keyboard.press("ControlOrMeta+z");
  expect(await vertices(page)).toEqual(before);

  // Typed: Local, then World (the same point, other numbers), one undo each.
  const x = page.locator(".path-panel input.cell").nth(0);
  const local = await x.inputValue();
  await page.locator(".path-panel").getByRole("button", { name: "World", exact: true }).click();
  expect(await x.inputValue()).not.toBe(local);
  await x.fill(String(Number(await x.inputValue()) + 12));
  await x.press("Enter");
  const typed = await vertices(page);
  // The vertex the drag chose stays the one the window shows: point 2, whose middle vertex is 4.
  expect(typed[0]).toBe(before[0]);
  expect(typed.slice(8, 10)).not.toEqual(before.slice(8, 10));
  await page.keyboard.press("ControlOrMeta+z");
  expect(await vertices(page)).toEqual(before);
  await page.locator(".path-panel").getByRole("button", { name: "Local", exact: true }).click();
  expect(await x.inputValue()).toBe(String(Math.round(before[8]! * 100) / 100));
});

test("Add Path Here in the stage's right-click menu puts a path where the pointer is; one undo removes it and its slot", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.evaluate(() => { const b = (window as unknown as Live).boneburst; b.workspace.api.getPanel("stage").api.maximize(); });
  await page.waitForTimeout(300);
  const box = (await page.locator(".stage canvas.overlay").boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.25, box.y + box.height * 0.3, { button: "right" });
  await page.getByRole("menuitem", { name: "Add Path Here" }).click();
  await expect.poll(async () => (await vertices(page)).length).toBe(12);
  await expect(page.locator(".path-panel")).toBeVisible();
  const slots = () => page.evaluate(() => ((window as unknown as { boneburst: { session: { doc: { slots: { name: string }[] } } } }).boneburst.session.doc.slots).map((x) => x.name));
  expect((await slots()).some((n) => n.endsWith("-path"))).toBe(true);
  await page.keyboard.press("ControlOrMeta+z");
  expect(await vertices(page)).toEqual([]);
  expect((await slots()).some((n) => n.endsWith("-path"))).toBe(false);
});
