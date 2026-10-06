import { type AttachmentRef, findAttachment, replaceAttachment } from "@/edit/attachments";
import type { Edit } from "@/edit/history";
import { type BoneWorlds, frameFor, positions } from "@/edit/meshLayout";
import { meshPoints } from "@/edit/trace";
import { triangulate } from "@/edit/triangulate";
import { bindMesh, meshBones } from "@/edit/weights";
import { type Attachment, attachmentType, type Skeleton } from "@/model/skeleton";
import { shortFloat } from "@/model/timelines";
import { applyEdit } from "./apply";
import { type AgentContext, AgentRefused } from "./context";
import { docOf } from "./read";
import { displaysOf, entryOf, imageOf, showing, slotNamed } from "./where";

/**
 * Meshes (E5-PLAN step 8): images turned into meshes along their opaque outline, bound to bones,
 * and other images linked to a mesh to bend with it. Each call is one History step "AI: …".
 */

type Args = Record<string, unknown>;

const setupWorlds = (ctx: AgentContext): BoneWorlds => ctx.pose(ctx.view().skin, null, 0).map((b) => b.world);
/** x and y as Spine writes them: left out at 0. */
const placed = (x: number, y: number) => ({ ...(x ? { x } : {}), ...(y ? { y } : {}) });
const where = (r: AttachmentRef) => `${r.skin === "default" ? "" : `${r.skin}/`}${r.slot}/${r.key}`;

/** Image pixel (px, py), y down, as a point of region `a` in its bone's space (as `regionCorners` places the image). */
function regionPoint(a: Attachment, W: number, H: number, px: number, py: number): [number, number] {
  const w = a.width ?? W, h = a.height ?? H, sx = a.scaleX ?? 1, sy = a.scaleY ?? 1;
  const r = ((a.rotation ?? 0) * Math.PI) / 180, cos = Math.cos(r), sin = Math.sin(r);
  const lx = (px / W - 0.5) * w * sx, ly = (0.5 - py / H) * h * sy;
  return [(a.x ?? 0) + lx * cos - ly * sin, (a.y ?? 0) + lx * sin + ly * cos];
}

async function makeMesh(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), edits: Edit<Skeleton>[] = [], made: Record<string, unknown>[] = [], notes: string[] = [];
  for (const image of new Set(args.images as string[])) {
    const region = ctx.images.regions.find((x) => x.name === image);
    if (!region) throw new AgentRefused(`There is no atlas image "${image}"; get_rig lists the images.`);
    const all = showing(doc, image);
    if (!all.length) throw new AgentRefused(`No slot shows "${image}": attach it first.`);
    const refs = all.filter((r) => { const a = findAttachment(doc, r)!; return attachmentType(a) === "region" && !a.sequence; });
    for (const r of all) if (!refs.includes(r)) notes.push(`${where(r)} is a ${findAttachment(doc, r)!.sequence ? "sequence" : attachmentType(findAttachment(doc, r)!)}, left as it is.`);
    if (!refs.length) continue;
    const W = region.originalWidth, H = region.originalHeight;
    const spacing = (args.spacing as number | undefined) ?? Math.max(8, Math.min(W, H) / 6);
    const pix = await ctx.pixels(image);
    const pts = meshPoints(pix && pix.width === W && pix.height === H ? pix.alpha : null, W, H, spacing);
    if (!pts.traced) notes.push(`${image}: its pixels are not to hand (or nothing in it is opaque), so the mesh follows its rectangle.`);
    const uvs = pts.xy.map((v, i) => shortFloat(v / (i % 2 ? H : W)));
    let triangles = 0;
    for (const r of refs) {
      const a = findAttachment(doc, r)!;
      const vertices = pts.xy.flatMap((_, i) => (i % 2 ? [] : regionPoint(a, W, H, pts.xy[i]!, pts.xy[i + 1]!).map(shortFloat)));
      const t = triangulate(vertices, pts.hull);
      // Inner points are inside the outline, so none should be left out; if one is, it goes.
      const keep = new Set(t.outside);
      const kept = (xs: readonly number[]) => xs.filter((_, i) => !keep.has(Math.floor(i / 2)));
      const vs = kept(vertices), us = kept(uvs), tris = keep.size ? triangulate(vs, pts.hull).triangles : t.triangles;
      const { x: _x, y: _y, rotation: _r, scaleX: _sx, scaleY: _sy, type: _t, ...rest } = a;
      const mesh = { ...rest, type: "mesh", uvs: us, triangles: tris, vertices: vs, hull: pts.hull } as Attachment;
      edits.push((s) => replaceAttachment(s, r, mesh));
      triangles = tris.length / 3;
    }
    made.push({ image, meshes: refs.map(where), points: pts.xy.length / 2, outline: pts.hull, triangles, traced: pts.traced });
  }
  if (!edits.length) throw new AgentRefused(`Nothing to turn into a mesh: ${notes.join(" ")}`);
  applyEdit(ctx, `make_mesh ${made.map((m) => m.image).join(", ")}`, (s) => edits.reduce((d, e) => e(d), s));
  return { made, ...(notes.length ? { notes } : {}) };
}

function bindMeshTool(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), image = String(args.image), bones = args.bones as string[];
  const refs = showing(doc, image).filter((r) => attachmentType(findAttachment(doc, r)!) === "mesh");
  if (!refs.length) throw new AgentRefused(`No mesh shows "${image}": make_mesh first.`);
  const worlds = setupWorlds(ctx);
  applyEdit(ctx, `bind_mesh ${image}`, (s) => refs.reduce((d, r) => bindMesh(r, bones, worlds)(d), s));
  const after = docOf(ctx);
  return { image, meshes: refs.map(where), bones: meshBones(findAttachment(after, refs[0]!)!).map((i) => after.bones![i]!.name) };
}

/** The affine map from a mesh's UVs to its positions, least squares: [A, B, C, D, E, F] with x = A u + B v + C, y = D u + E v + F. */
export function uvAffine(uvs: readonly number[], xy: readonly number[]): number[] | null {
  const n = uvs.length / 2;
  let suu = 0, suv = 0, svv = 0, su = 0, sv = 0;
  const rhs = [[0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < n; i++) {
    const u = uvs[i * 2]!, v = uvs[i * 2 + 1]!;
    suu += u * u; suv += u * v; svv += v * v; su += u; sv += v;
    for (let k = 0; k < 2; k++) { const p = xy[i * 2 + k]!; rhs[k]![0]! += u * p; rhs[k]![1]! += v * p; rhs[k]![2]! += p; }
  }
  const m = [[suu, suv, su], [suv, svv, sv], [su, sv, n]];
  const det = (a: number[][]) => a[0]![0]! * (a[1]![1]! * a[2]![2]! - a[1]![2]! * a[2]![1]!) - a[0]![1]! * (a[1]![0]! * a[2]![2]! - a[1]![2]! * a[2]![0]!) + a[0]![2]! * (a[1]![0]! * a[2]![1]! - a[1]![1]! * a[2]![0]!);
  const d = det(m);
  if (Math.abs(d) < 1e-12) return null;
  const solve = (r: number[]) => [0, 1, 2].map((c) => det(m.map((row, i) => row.map((v, j) => (j === c ? r[i]! : v)))) / d);
  return [...solve(rhs[0]!), ...solve(rhs[1]!)];
}

function linkMesh(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), slot = slotNamed(doc, args.layer).name, image = String(args.image);
  const skins = ["default", ...(doc.skins ?? []).map((k) => k.name).filter((n) => n !== "default")];
  // The image's attachment in the slot, the default skin's first.
  let at: AttachmentRef | undefined;
  for (const skin of skins) for (const key of displaysOf(doc, slot)) {
    const a = entryOf(doc, skin, slot, key);
    if (!at && a && imageOf(a, key) === image) at = { skin, slot, key };
  }
  if (!at) throw new AgentRefused(`The slot "${slot}" has no attachment showing "${image}": attach it there first (an attachment key shows it).`);
  const a = findAttachment(doc, at)!;
  if (args.linked === false) {
    if (a.source === undefined) return { layer: slot, image, linked: false, note: `"${at.key}" is not linked.` };
    const src: AttachmentRef = { skin: a.skin ?? "default", slot: a.slot ?? slot, key: a.source }, mesh = findAttachment(doc, src)!;
    const pos = positions(mesh, frameFor(doc, src, mesh, setupWorlds(ctx)));
    const f = uvAffine(mesh.uvs!, pos), region = ctx.images.regions.find((x) => x.name === image);
    if (!f) throw new AgentRefused(`The mesh "${src.key}" has no area to place "${image}" by.`);
    const [A, B, C, D, E, F] = f as [number, number, number, number, number, number];
    const W = region?.originalWidth ?? a.width ?? 32, H = region?.originalHeight ?? a.height ?? 32;
    // The region whose corners land where the mesh puts its UV corners (v runs down the image).
    const rot = Math.atan2(D, A), sx = Math.hypot(A, D) / W, sy = Math.hypot(B, E) / H;
    const r2 = (n: number) => Math.round(n * 100) / 100 || 0;
    const { source: _s, skin: _k, slot: _l, timelines: _t, type: _y, vertices: _v, uvs: _u, triangles: _r, hull: _h, edges: _e, ...rest } = a;
    const out = {
      ...rest, ...placed(r2(A * 0.5 + B * 0.5 + C), r2(D * 0.5 + E * 0.5 + F)), width: W, height: H,
      ...(r2((rot * 180) / Math.PI) ? { rotation: r2((rot * 180) / Math.PI) } : {}),
      ...(Math.abs(sx - 1) > 1e-4 ? { scaleX: shortFloat(sx) } : {}), ...(Math.abs(sy - 1) > 1e-4 ? { scaleY: shortFloat(sy) } : {}),
    } as Attachment;
    applyEdit(ctx, `link_mesh ${slot} ${image} unlinked`, (s) => replaceAttachment(s, at!, out));
    return { layer: slot, image, linked: false };
  }
  // The slot's mesh: its setup attachment when that is one, else its first.
  const setupKey = doc.slots!.find((x) => x.name === slot)!.attachment;
  let src: AttachmentRef | undefined;
  for (const skin of skins) for (const key of [...(setupKey ? [setupKey] : []), ...displaysOf(doc, slot)]) {
    const m = entryOf(doc, skin, slot, key);
    if (!src && m && attachmentType(m) === "mesh" && !(skin === at.skin && key === at.key)) src = { skin, slot, key };
  }
  if (!src) throw new AgentRefused(`The slot "${slot}" has no mesh for "${image}" to follow: make_mesh its own image first.`);
  if (src.skin !== at.skin && src.skin !== "default") throw new AgentRefused(`The mesh "${src.key}" is in skin "${src.skin}", "${image}" in "${at.skin}": a linked mesh takes its source from the default skin or its own.`);
  const type = attachmentType(a);
  if (type !== "region" && type !== "linkedmesh") throw new AgentRefused(`"${at.key}" is a ${type}: only an image (a region) can be linked to a mesh.`);
  const deform = args.deform !== false;
  const { x: _x, y: _y, rotation: _r, scaleX: _sx, scaleY: _sy, type: _t, source: _s, skin: _k, timelines: _tl, ...rest } = a;
  const linked = { ...rest, type: "linkedmesh", source: src.key, ...(src.skin !== "default" ? { skin: src.skin } : {}), ...(deform ? {} : { timelines: false }) } as Attachment;
  applyEdit(ctx, `link_mesh ${slot} ${image}`, (s) => replaceAttachment(s, at!, linked));
  return { layer: slot, image, linked: true, mesh: src.key, deform };
}

export const MESH_TOOLS = { make_mesh: makeMesh, bind_mesh: bindMeshTool, link_mesh: linkMesh } as const;
