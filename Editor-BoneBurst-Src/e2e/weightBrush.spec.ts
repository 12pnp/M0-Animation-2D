import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

/** Through the analysis window a Spine export now opens with (docs/SPINE-IMPORT-FRAMEPATH-PLAN.md): opened as it is. */
async function openAsIs(page: import("@playwright/test").Page): Promise<void> {
  await page.getByRole("dialog", { name: "Open: analysis" }).getByRole("button", { name: /^Open( as is)?$/ }).click();
}


/**
 * The weight brush (E6-PLAN step 4f): on spineboy-pro, a weighted mesh selected, a bone chosen in
 * Show weights and Paint weights on, a stroke over one of its vertices raises that bone's weight
 * there; Alt takes it away; one undo takes a stroke back.
 */

const SPINEBOY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "Packages", "com.module.ta-creator-boneburst", "Tests", "Editor", "Data~", "samples", "spineboy-pro");

type Live = { boneburst: { session: any; stage: { camera: { x: number; y: number; zoom: number } } } };

/** A shown weighted mesh with a vertex two bones share: where, which bone, and that bone's weight there now. */
const target = (page: Page) => page.evaluate(() => {
  const s = (window as unknown as Live).boneburst.session, doc = s.doc, p = s.pose();
  for (const slot of doc.slots) {
    const entries = doc.skins.find((k: any) => k.name === "default").attachments.find((x: any) => x.slot === slot.name)?.entries ?? [];
    const e = entries.find((x: any) => x.key === slot.attachment);
    const a = e?.attachment;
    if (!a || (a.type !== "mesh") || a.vertices.length === a.uvs.length) continue;
    // Decode the weighted vertices: [count, bone, x, y, w, …] per vertex.
    const binds: { bone: number; w: number }[][] = [];
    for (let i = 0; i < a.vertices.length;) { const n = a.vertices[i++]; const b = []; for (let j = 0; j < n; j++, i += 4) b.push({ bone: a.vertices[i], w: a.vertices[i + 3] }); binds.push(b); }
    const v = binds.findIndex((b) => b.length >= 2 && b[0]!.w < 0.6);
    if (v < 0) continue;
    const si = p.rig.data.slots.findIndex((x: any) => x.name === slot.name), data = p.rig.attachmentOf(si);
    const world = new Float64Array(binds.length * 2);
    p.rig.vertexWorld(si, data, 0, world.length, world, 0);
    return { ref: { kind: "attachment", skin: "default", slot: slot.name, key: e.key }, v, bone: doc.bones[binds[v]![0]!.bone].name, w: binds[v]![0]!.w, at: [world[v * 2], world[v * 2 + 1]] as [number, number] };
  }
  return null;
});

/** The bone's weight on vertex `v` of the mesh at `ref` now. */
const weight = (page: Page, ref: any, v: number, bone: string) => page.evaluate(([r, vi, b]) => {
  const doc = (window as unknown as Live).boneburst.session.doc, bi = doc.bones.findIndex((x: any) => x.name === b);
  const a = doc.skins.find((k: any) => k.name === r.skin).attachments.find((x: any) => x.slot === r.slot).entries.find((x: any) => x.key === r.key).attachment;
  let i = 0;
  for (let n = 0; n < vi; n++) i += 1 + a.vertices[i] * 4;
  const count = a.vertices[i++];
  for (let j = 0; j < count; j++, i += 4) if (a.vertices[i] === bi) return a.vertices[i + 3] as number;
  return 0;
}, [ref, v, bone] as const);

test("Paint weights: a stroke over a vertex raises the shown bone's weight there; Alt takes it away; one undo per stroke", async ({ page }) => {
  await page.goto("/");
  // The stage panels off: on this small stage they would cover the vertex being painted.
  await page.evaluate(() => localStorage.setItem("boneburst.preferences", JSON.stringify({ version: 1, stagePanels: false })));
  await page.reload();
  await page.locator("input[type=file]:not([webkitdirectory])").setInputFiles(["spineboy-pro.json", "spineboy-pro.atlas.txt", "spineboy-pro.png"].map((f) => join(SPINEBOY, f)));
  await openAsIs(page);
  await page.waitForFunction(() => document.title.includes("spineboy-pro"));
  const t = (await target(page))!;
  expect(t).not.toBeNull();
  await page.evaluate(([ref, bone]) => { const s = (window as unknown as Live).boneburst.session; s.select(ref); s.weightBone = bone; s.changed(); }, [t.ref, t.bone] as const);
  await page.locator(".dv-tab", { hasText: /^Properties$/ }).getByText("Properties", { exact: true }).click().catch(() => undefined);
  await page.getByRole("checkbox", { name: "Paint weights" }).check();

  // The vertex on the page.
  const box = (await page.locator(".stage canvas.overlay").boundingBox())!;
  const cam = await page.evaluate(() => (window as unknown as Live).boneburst.stage.camera);
  const x = box.x + box.width / 2 + (t.at[0] - cam.x) * cam.zoom, y = box.y + box.height / 2 - (t.at[1] - cam.y) * cam.zoom;
  const stroke = async (alt: boolean) => {
    if (alt) await page.keyboard.down("Alt");
    await page.mouse.move(x - 3, y);
    await page.mouse.down();
    await page.mouse.move(x + 3, y, { steps: 4 });
    await page.mouse.up();
    if (alt) await page.keyboard.up("Alt");
  };
  await stroke(false);
  const raised = await weight(page, t.ref, t.v, t.bone);
  expect(raised).toBeGreaterThan(t.w + 0.1);
  await stroke(true);
  expect(await weight(page, t.ref, t.v, t.bone)).toBeLessThan(raised - 0.05);
  // One undo per stroke: two strokes back to where it began.
  await page.keyboard.press("ControlOrMeta+z");
  expect(await weight(page, t.ref, t.v, t.bone)).toBeCloseTo(raised, 4);
  await page.keyboard.press("ControlOrMeta+z");
  expect(await weight(page, t.ref, t.v, t.bone)).toBeCloseTo(t.w, 4);
});
