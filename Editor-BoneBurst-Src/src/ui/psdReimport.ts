import { addRegion, type AttachmentRef, updateAttachment } from "@/edit/attachments";
import { type Edit, EditRefused } from "@/edit/history";
import { type BoneWorlds, frameFor, positions, round, toLocal } from "@/edit/meshLayout";
import { addSlot, updateSlot } from "@/edit/slots";
import type { ImageRegion } from "@/engine/regions";
import { pack, type PackImage, type Page } from "@/io/pack";
import type { PngImage } from "@/io/png";
import type { Atlas } from "@/model/atlas";
import type { PsdLayer, PsdLayers } from "@/io/psd";
import type { Issue } from "@/model/issue";
import { type Attachment, attachmentType, type Skeleton } from "@/model/skeleton";
import { unique } from "./panels/outline";
import { layerBlend, layerCentre, layerNames } from "./psdImport";

/**
 * A Photoshop file brought into the rig built from it (E4-PLAN step 14). Pure: from the rig, its
 * setup-pose bone matrices, its atlas's regions and the file's layers, what changes: one edit to
 * the skeleton, the new images to pack, the regions to copy from the old pages, and a report.
 *
 * A layer belongs to the atlas region named as the first import named it. A region attachment
 * takes the layer's trimmed pixels, place and size; a mesh keeps its geometry and gets the
 * layer's pixels cut to its picture's rectangle; a new layer becomes a slot and region on the
 * root; regions no layer matches are kept as they are.
 */

export interface ReimportPlan {
  readonly edit: Edit<Skeleton>;
  /** New pixels: matched layers (trimmed, or cut to a mesh's picture) and added ones. */
  readonly images: readonly PackImage[];
  /** Atlas regions copied from the old pages, as they are. */
  readonly kept: readonly ImageRegion[];
  readonly updated: readonly string[];
  readonly moved: readonly string[];
  readonly added: readonly string[];
  readonly issues: readonly Issue[];
}

/** Refused: why the rig cannot take the file (nothing is changed). */
export class ReimportRefused extends Error {}

interface Use { readonly ref: AttachmentRef; readonly a: Attachment; readonly kind: string }

const apply = (m: readonly number[], x: number, y: number): [number, number] => [m[0]! * x + m[1]! * y + m[4]!, m[2]! * x + m[3]! * y + m[5]!];
const r2 = (n: number) => round(n, 2);

/** Every attachment that shows an image, by the region it shows (its path, or else its name). */
function imageUsers(doc: Skeleton): Map<string, Use[]> {
  const out = new Map<string, Use[]>();
  for (const skin of doc.skins ?? []) {
    for (const ss of skin.attachments ?? []) {
      for (const e of ss.entries) {
        const kind = attachmentType(e.attachment);
        if (!["region", "mesh", "linkedmesh"].includes(kind)) continue;
        const image = e.attachment.path ?? e.attachment.name ?? e.key;
        out.set(image, [...(out.get(image) ?? []), { ref: { skin: skin.name, slot: ss.slot, key: e.key }, a: e.attachment, kind }]);
      }
    }
  }
  return out;
}

/** The world matrix of the slot's bone. */
function slotMatrix(doc: Skeleton, bones: BoneWorlds, slot: string): readonly number[] | null {
  const bone = doc.slots?.find((x) => x.name === slot)?.bone;
  const i = (doc.bones ?? []).findIndex((b) => b.name === bone);
  return i >= 0 ? bones[i] ?? null : null;
}

/** A linked mesh's source mesh (in its own skin, else the default skin), or the mesh itself. */
function geometry(doc: Skeleton, u: Use): { a: Attachment; ref: AttachmentRef } | null {
  if (u.kind !== "linkedmesh") return u;
  for (const skin of [u.a.skin ?? u.ref.skin, "default"]) {
    const ss = doc.skins?.find((k) => k.name === skin)?.attachments?.find((x) => x.slot === u.ref.slot);
    const e = ss?.entries.find((x) => x.key === u.a.source);
    if (e && attachmentType(e.attachment) === "mesh") return { a: e.attachment, ref: { skin, slot: u.ref.slot, key: e.key } };
  }
  return null;
}

/**
 * Where a mesh's picture lies in the world on the setup pose: its top-left corner, when its UVs
 * map to the world one pixel per unit, upright (the mesh not turned or scaled against its
 * picture). Fitted by least squares over its vertices, so a few stretched ones do not hide it.
 */
export function meshPicture(uvs: readonly number[], world: readonly number[], width: number, height: number): [number, number] | null {
  const n = uvs.length / 2;
  if (n < 3) return null;
  // Normal equations for x = A u + B v + C (and y alike).
  let suu = 0, suv = 0, svv = 0, su = 0, sv = 0, sux = 0, svx = 0, sx = 0, suy = 0, svy = 0, sy = 0;
  for (let i = 0; i < n; i++) {
    const u = uvs[i * 2]!, v = uvs[i * 2 + 1]!, x = world[i * 2]!, y = world[i * 2 + 1]!;
    suu += u * u; suv += u * v; svv += v * v; su += u; sv += v;
    sux += u * x; svx += v * x; sx += x; suy += u * y; svy += v * y; sy += y;
  }
  const m = [[suu, suv, su], [suv, svv, sv], [su, sv, n]] as const;
  const det3 = (a: readonly (readonly number[])[]) => a[0]![0]! * (a[1]![1]! * a[2]![2]! - a[1]![2]! * a[2]![1]!) - a[0]![1]! * (a[1]![0]! * a[2]![2]! - a[1]![2]! * a[2]![0]!) + a[0]![2]! * (a[1]![0]! * a[2]![1]! - a[1]![1]! * a[2]![0]!);
  const d = det3(m);
  if (Math.abs(d) < 1e-12) return null;
  const solve = (r: readonly number[]) => [0, 1, 2].map((c) => det3(m.map((row, i) => row.map((v, j) => (j === c ? r[i]! : v)))) / d);
  const [A, B, C] = solve([sux, svx, sx]) as [number, number, number];
  const [D, E, F] = solve([suy, svy, sy]) as [number, number, number];
  const near = (a: number, b: number) => Math.abs(a - b) <= 0.5;
  if (!near(A, width) || !near(B, 0) || !near(D, 0) || !near(E, -height)) return null;
  for (let i = 0; i < n; i++) {
    const u = uvs[i * 2]!, v = uvs[i * 2 + 1]!;
    if (!near(A * u + B * v + C, world[i * 2]!) || !near(D * u + E * v + F, world[i * 2 + 1]!)) return null;
  }
  return [C, F];
}

/** The layer's pixels in the canvas rectangle (left, top, width, height), and how many painted pixels fell outside it. */
export function cutLayer(l: PsdLayer, left: number, top: number, width: number, height: number): { pixels: Uint8ClampedArray; outside: number } {
  const px = new Uint8ClampedArray(width * height * 4);
  let outside = 0;
  for (let y = 0; y < l.height; y++) {
    for (let x = 0; x < l.width; x++) {
      const s = (y * l.width + x) * 4, cx = l.left + x - left, cy = l.top + y - top;
      if (cx < 0 || cy < 0 || cx >= width || cy >= height) { if (l.pixels[s + 3]) outside++; continue; }
      px.set(l.pixels.subarray(s, s + 4), (cy * width + cx) * 4);
    }
  }
  return { pixels: px, outside };
}

const regionKey = (r: ImageRegion) => `${r.name}\u0000${r.index}`;
const stripped = (r: ImageRegion) => r.offsetX !== 0 || r.offsetY !== 0 || r.originalWidth !== r.width || r.originalHeight !== r.height;

export function planReimport(doc: Skeleton, bones: BoneWorlds, regions: readonly ImageRegion[], psd: PsdLayers, file: string): ReimportPlan {
  if (regions.some((r) => r.page.pma)) throw new ReimportRefused(`The rig's atlas is premultiplied; the editor packs straight colours. Export the atlas without premultiplied alpha, then re-import ${file}.`);
  if (!psd.layers.length) throw new ReimportRefused(`${file} has no visible layer with pixels.`);
  const issues: Issue[] = [...psd.issues];
  const where = (l: PsdLayer) => `${file}: ${[...l.groups, l.name].join(" / ")}`;
  const names = layerNames(psd.layers);
  const byName = new Map<string, ImageRegion[]>();
  for (const r of regions) byName.set(r.name, [...(byName.get(r.name) ?? []), r]);
  const users = imageUsers(doc);
  const matched = psd.layers.map((l, i) => ({ l, n: names[i]!, regions: byName.get(names[i]!) ?? [] }));

  // Where the canvas is: the offset most matched region attachments share between where they
  // show now and where the file has their layer (the root may have moved since the import).
  const votes = new Map<string, { off: [number, number]; n: number }>();
  for (const { l, n, regions: rs } of matched) {
    if (rs.length !== 1 || stripped(rs[0]!)) continue;
    const r = rs[0]!;
    if (r.width !== l.width || r.height !== l.height) continue;
    for (const u of users.get(n) ?? []) {
      const m = u.kind === "region" ? slotMatrix(doc, bones, u.ref.slot) : null;
      if (!m) continue;
      const [wx, wy] = apply(m, u.a.x ?? 0, u.a.y ?? 0), [cx, cy] = layerCentre(l, psd);
      const off: [number, number] = [r2(wx - cx), r2(wy - cy)], key = off.join();
      votes.set(key, { off, n: (votes.get(key)?.n ?? 0) + 1 });
    }
  }
  const best = [...votes.values()].sort((a, b) => b.n - a.n)[0];
  const offset: [number, number] = best && best.n >= 2 ? best.off : [0, 0];
  const world = (l: PsdLayer): [number, number] => { const [x, y] = layerCentre(l, psd); return [x + offset[0], y + offset[1]]; };

  const images: PackImage[] = [], updated: string[] = [], moved: string[] = [], added: string[] = [];
  const replaced = new Set<string>();
  const patches: { ref: AttachmentRef; patch: { x: number | undefined; y: number | undefined; width: number; height: number } }[] = [];
  for (const { l, n, regions: rs } of matched) {
    if (!rs.length) continue;
    if (rs.length > 1) { issues.push({ where: where(l), message: `"${n}" is a sequence of ${rs.length} images in the atlas; kept as it was` }); continue; }
    const r = rs[0]!, mine = users.get(n) ?? [];
    const meshes = mine.filter((u) => u.kind !== "region");
    if (meshes.length) {
      // The meshes' picture: one rectangle on the canvas they all agree on.
      let rect: [number, number] | null | undefined;
      for (const u of meshes) {
        const g = geometry(doc, u), m = slotMatrix(doc, bones, u.ref.slot);
        let corner: [number, number] | null = null;
        if (g && m && !stripped(r) && g.a.uvs && g.a.vertices) {
          const local = positions(g.a, frameFor(doc, g.ref, g.a, bones));
          const w: number[] = [];
          for (let i = 0; i < local.length; i += 2) w.push(...apply(m, local[i]!, local[i + 1]!));
          corner = meshPicture(g.a.uvs, w, r.originalWidth, r.originalHeight);
        }
        if (!corner || (rect && (Math.abs(rect[0] - corner[0]) > 0.5 || Math.abs(rect[1] - corner[1]) > 0.5))) { rect = null; break; }
        rect = corner;
      }
      if (!rect) {
        issues.push({ where: where(l), message: `"${n}" is a mesh turned, scaled, stretched or whitespace-trimmed against its picture: its old pixels are kept` });
        continue;
      }
      const left = Math.round(rect[0] - offset[0] + psd.width / 2), top = Math.round(psd.height - (rect[1] - offset[1]));
      const cut = cutLayer(l, left, top, r.originalWidth, r.originalHeight);
      if (cut.outside) issues.push({ where: where(l), message: `${cut.outside} painted pixels of "${n}" lie outside its mesh and were cut: move the mesh's outline over them to show them` });
      images.push({ name: n, width: r.originalWidth, height: r.originalHeight, pixels: cut.pixels });
      replaced.add(regionKey(r));
      updated.push(n);
      continue;
    }
    images.push({ name: n, width: l.width, height: l.height, pixels: l.pixels });
    replaced.add(regionKey(r));
    updated.push(n);
    let wasMoved = false;
    for (const u of mine) {
      const m = slotMatrix(doc, bones, u.ref.slot);
      if (!m) continue;
      const before = apply(m, u.a.x ?? 0, u.a.y ?? 0), after = world(l);
      const [x, y] = toLocal(m, after[0], after[1]);
      if (Math.hypot(after[0] - before[0], after[1] - before[1]) > 0.5) wasMoved = true;
      patches.push({ ref: u.ref, patch: {
        // 0 is left out, as the first import leaves it.
        x: r2(x) || undefined, y: r2(y) || undefined,
        width: r2((u.a.width ?? r.originalWidth) * l.width / r.originalWidth),
        height: r2((u.a.height ?? r.originalHeight) * l.height / r.originalHeight),
      } });
    }
    if (wasMoved) moved.push(n);
  }

  const kept = regions.filter((r) => !replaced.has(regionKey(r)));
  const turned = kept.find((r) => r.degrees !== 0);
  if (turned) throw new ReimportRefused(`The atlas packs "${turned.name}" turned; the editor copies regions upright only. Export the atlas without rotation, then re-import ${file}.`);

  // New layers: a slot and region on the root, just above the nearest layer under it the rig shows.
  const root = (doc.bones ?? []).find((b) => b.parent === undefined)?.name;
  const rootIndex = (doc.bones ?? []).findIndex((b) => b.name === root);
  const taken = [...(doc.slots ?? []).map((s) => s.name), ...regions.map((r) => r.name), ...names];
  const slotOf: (string | null)[] = matched.map(({ n, regions: rs }) => (rs.length ? (users.get(n) ?? []).find((u) => doc.slots?.some((s) => s.name === u.ref.slot))?.ref.slot ?? null : null));
  const additions: { name: string; below: string | null; l: PsdLayer; blend: string }[] = [];
  matched.forEach(({ l, n, regions: rs }, i) => {
    if (rs.length || root === undefined) return;
    const name = taken.filter((t) => t === n).length > 1 ? unique(n, taken) : n;
    if (name !== n) taken.push(name);
    let below: string | null = null;
    for (let j = i - 1; j >= 0 && below === null; j--) below = slotOf[j] ?? null;
    slotOf[i] = name;
    additions.push({ name, below, l, blend: layerBlend(l, file, issues) });
    images.push({ name, width: l.width, height: l.height, pixels: l.pixels });
    added.push(name);
  });
  if (root === undefined && matched.some((m) => !m.regions.length)) issues.push({ where: file, message: "the skeleton has no root bone: new layers were not added" });
  for (const r of kept) issues.push({ where: file, message: `"${r.name}" is not a visible layer of the file: kept as it was` });

  const rootMatrix = bones[rootIndex];
  const edit: Edit<Skeleton> = (s0) => {
    let s = s0;
    for (const p of patches) s = updateAttachment(p.ref, p.patch)(s);
    for (const a of additions) {
      if (!rootMatrix) throw new EditRefused("The root bone has no place on the setup pose.");
      const at = a.below === null ? 0 : (s.slots ?? []).findIndex((x) => x.name === a.below) + 1;
      const [wx, wy] = world(a.l), [x, y] = toLocal(rootMatrix, wx, wy);
      s = addSlot(a.name, root!, at)(s);
      s = addRegion({ skin: "default", slot: a.name, key: a.name }, { width: a.l.width, height: a.l.height, ...(r2(x) ? { x: r2(x) } : {}), ...(r2(y) ? { y: r2(y) } : {}) })(s);
      const alpha = Math.round(Math.max(0, Math.min(1, a.l.opacity)) * 255);
      s = updateSlot(a.name, {
        attachment: a.name,
        ...(alpha < 255 ? { color: `ffffff${alpha.toString(16).padStart(2, "0")}` } : {}),
        ...(a.blend !== "normal" ? { blend: a.blend } : {}),
      })(s);
    }
    return s;
  };
  return { edit, images, kept, updated, moved, added, issues };
}

/** Fields that say where a region was packed: the new atlas writes its own. */
const PACKED = new Set(["bounds", "xy", "size", "rotate"]);

/**
 * The new atlas and pages, named after the skeleton: the plan's new images and the kept regions
 * copied bit for bit from the old pages (`pages`, by file name), keeping their other fields
 * (`offsets`, `index`, …). Refused when a kept region's page was not given.
 */
export function rebuildAtlas(plan: ReimportPlan, atlas: Atlas, pages: ReadonlyMap<string, PngImage>, name: string): { atlas: Atlas; pages: Page[] } {
  const images: PackImage[] = [...plan.images];
  for (const r of plan.kept) {
    const page = pages.get(r.page.name);
    if (!page) throw new ReimportRefused(`The page "${r.page.name}" was not opened with the rig, so "${r.name}" cannot be copied. Open the rig with all its pages, then re-import.`);
    const raw = atlas.pages.find((p) => p.name === r.page.name)?.regions.find((x) => x.name === r.name && sameIndex(x.fields, r.index));
    const px = new Uint8ClampedArray(r.width * r.height * 4);
    for (let y = 0; y < r.height; y++) px.set(page.pixels.subarray(((r.y + y) * page.width + r.x) * 4, ((r.y + y) * page.width + r.x + r.width) * 4), y * r.width * 4);
    images.push({ name: r.name, width: r.width, height: r.height, pixels: px, fields: (raw?.fields ?? []).filter((f) => !PACKED.has(f.key)) });
  }
  const packed = pack(images, name);
  return { atlas: packed.atlas, pages: packed.pages };
}

const sameIndex = (fields: readonly { key: string; values: readonly string[] }[], index: number) => Number(fields.find((f) => f.key === "index")?.values[0] ?? 0) === index;
