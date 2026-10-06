import { expect, test } from "@playwright/test";

/** Path attachments (docs/PATH-PLAN.md): drag a point on the stage, type a vertex in Local or World, one undo each. */

type Live = { boneburst: { session: { select(s: unknown): void; doc: { skins: { attachments: { slot: string; entries: { key: string; attachment: { vertices: number[]; vertexCount: number } }[] }[] }[] }; history: { undo(): void; apply(l: string, e: unknown): void }; changed(): void; pathVertex: number | null; pose(): unknown }; stage: { camera: { x: number; y: number; zoom: number }; size: { width: number; height: number }; fitView(): void }; workspace: { api: { getPanel(id: string): { api: { maximize(): void } } } } } };

const vertices = (page: import("@playwright/test").Page) => page.evaluate(() => (window as unknown as Live).boneburst.session.doc.skins[0]!.attachments.find((s) => s.slot === "rope")!.entries[0]!.attachment.vertices.slice());

test("a path's point dragged on the stage, typed in Local and World, undone in one step each", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, snap: false })));
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  // A path on the hips (the app has no way to add one yet: through the edit functions, as the agent does).
  await page.evaluate(async () => {
    const s = (window as unknown as Live).boneburst.session;
    // Dev-server modules, by variable path so the type-check does not look for them.
    const modules = ["/src/edit/attachments.ts", "/src/edit/slots.ts"];
    const att = await import(/* @vite-ignore */ modules[0]!), slots = await import(/* @vite-ignore */ modules[1]!);
    s.history.apply("slot", slots.addSlot("rope", "hips"));
    s.history.apply("path", att.addAttachment({ skin: "default", slot: "rope", key: "rope" }, { type: "path", constantSpeed: false, vertexCount: 12, lengths: [0, 0, 0, 0], extra: new Map(),
      vertices: [-60, 0, 0, 0, 40, 0, 60, 80, 100, 80, 140, 80, 200, 0, 240, 0, 280, 0, 300, -80, 340, -80, 380, -80] } as never));
    s.changed();
    s.select({ kind: "attachment", skin: "default", slot: "rope", key: "rope" });
  });
  await expect(page.locator(".path-panel")).toBeVisible();
  // The stage's own size is small in this layout: the point's screen place, from the camera.
  await page.evaluate(() => { const b = (window as unknown as Live).boneburst; b.workspace.api.getPanel("stage").api.maximize(); b.stage.fitView(); });
  await page.waitForTimeout(400);
  const before = await vertices(page);
  const at = await page.evaluate(async () => {
    const b = (window as unknown as Live).boneburst, pv = await import(/* @vite-ignore */ "/src/ui/stage/" + "pathView.ts");
    const view = pv.pathView(b.session.doc as never, b.session.pose() as never, { skin: "default", slot: "rope", key: "rope" })!;
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
