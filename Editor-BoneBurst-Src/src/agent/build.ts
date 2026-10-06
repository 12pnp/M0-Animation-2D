import { addAttachment, addRegion, type AttachmentRef, findAttachment, replaceAttachment, updateAttachment } from "@/edit/attachments";
import { addBone, updateBone } from "@/edit/bones";
import { addConstraint, moveConstraint, updateConstraint } from "@/edit/constraints";
import type { Edit } from "@/edit/history";
import { isWeighted, toLocal } from "@/edit/meshLayout";
import { addSlot, moveSlot, updateSlot } from "@/edit/slots";
import { type Attachment, attachmentType, type Constraint, type Skeleton, type TransformFrom } from "@/model/skeleton";
import { applyEdit, inStep } from "./apply";
import { type AgentContext, AgentRefused, type PosedBone } from "./context";
import { docOf, regionPlace } from "./read";
import { autoRigPlan, type RigPicture } from "./rig/autoRig";
import type { MotionView, Point } from "./rig/views";

/**
 * The building tools (E5-PLAN step 5): bones from joints, pictures put on them, IK, drawing order,
 * constraints, boxes and points, and `auto_rig`. Each call is one History step; a tool that builds
 * on what it just made runs as one gesture, posed between its parts (`inStep`).
 */

type Args = Record<string, unknown>;
type M = readonly number[];

const r2 = (n: number) => { const v = Math.round(n * 100) / 100; return v === 0 ? 0 : v; };
const deg = (m: M) => (Math.atan2(m[2]!, m[0]!) * 180) / Math.PI;
const apply = (m: M, x: number, y: number): [number, number] => [m[0]! * x + m[1]! * y + m[4]!, m[2]! * x + m[3]! * y + m[5]!];
const IDENTITY: M = [1, 0, 0, 1, 0, 0];
const unique = (base: string, taken: (n: string) => boolean) => { if (!taken(base)) return base; for (let i = 2; ; i++) if (!taken(`${base}${i}`)) return `${base}${i}`; };

/** Every bone's setup-pose world matrix, from the document as it is now. */
function setupWorlds(ctx: AgentContext): Map<string, PosedBone> {
  return new Map(ctx.pose(ctx.view().skin, null, 0).map((b) => [b.name, b]));
}

function boneOf(doc: Skeleton, name: string) {
  const b = doc.bones?.find((x) => x.name === name);
  if (!b) throw new AgentRefused(`There is no bone "${name}".`);
  return b;
}

/** A bone's local values under the parent world matrix `m`, from its joint and tip in skeleton space (exact under scale and shear). */
export function localBone(m: M, from: Point, to: Point): { x: number; y: number; rotation: number; length: number } {
  const [x, y] = toLocal(m, from[0], from[1]);
  const [tx, ty] = toLocal(m, to[0], to[1]);
  const dx = tx - x, dy = ty - y;
  return { x: r2(x), y: r2(y), rotation: r2((Math.atan2(dy, dx) * 180) / Math.PI), length: r2(Math.hypot(dx, dy)) };
}

/**
 * The attachment `a`, given in the space of the bone with world `from`, re-expressed in the
 * space of `to` so it stays where it is: a region's or point's place and turn, unweighted vertices.
 */
export function reexpress(a: Attachment, from: M, to: M): Attachment {
  const kind = attachmentType(a);
  if (kind === "region" || kind === "point") {
    const [wx, wy] = apply(from, a.x ?? 0, a.y ?? 0), [x, y] = toLocal(to, wx, wy);
    const rotation = r2((a.rotation ?? 0) + deg(from) - deg(to));
    return { ...a, x: r2(x), y: r2(y), rotation } as Attachment;
  }
  if (a.vertices && !isWeighted(a) && kind !== "linkedmesh") {
    const v: number[] = [];
    for (let i = 0; i < a.vertices.length; i += 2) { const [wx, wy] = apply(from, a.vertices[i]!, a.vertices[i + 1]!); const [x, y] = toLocal(to, wx, wy); v.push(r2(x), r2(y)); }
    return { ...a, vertices: v } as Attachment;
  }
  return a;
}

/** Leave zeros out, as the editor writes. */
const placed = (o: Record<string, number>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== 0));

// ── bones ──

interface BoneArg { name: string; parent?: string; from?: Point; to?: Point; x?: number; y?: number; rotation?: number; length?: number }

function addBones(args: Args, ctx: AgentContext) {
  const list = args.bones as BoneArg[];
  return inStep(ctx, `add_bones ${list.map((b) => b.name).join(", ")}`, (step) => {
    const made: Record<string, unknown>[] = [];
    for (const b of list) {
      if ((b.from === undefined) !== (b.to === undefined)) throw new AgentRefused(`${b.name}: give both from and to, or neither (then x, y, rotation, length).`);
      let local: { x?: number; y?: number; rotation?: number; length?: number };
      // A skeleton has one root: a bone given no parent goes under it.
      const root = docOf(ctx).bones?.find((x) => x.parent === undefined)?.name;
      const parentName = b.parent ?? root ?? null;
      if (b.from && b.to) {
        const parent = parentName === null ? IDENTITY : setupWorlds(ctx).get(parentName)?.world;
        if (!parent) throw new AgentRefused(`${b.name}: there is no bone "${b.parent}" (a parent comes earlier in the list or exists already).`);
        local = localBone(parent, b.from, b.to);
      } else local = { x: b.x ?? 0, y: b.y ?? 0, rotation: b.rotation ?? 0, ...(b.length !== undefined ? { length: b.length } : {}) };
      step(addBone(b.name, parentName, placed(local as Record<string, number>)));
      made.push({ name: b.name, ...(b.parent ? { parent: b.parent } : {}), ...local });
    }
    return { bones: made };
  });
}

// ── pictures ──

interface AttachArg { bone: string; image?: string; layer?: string; name?: string; pivot?: Point; at?: Point; rotation?: number; scale?: number }

/** Put a slot onto `bone`, every attachment it has in every skin re-expressed so it stays put. */
function moveSlotOnto(ctx: AgentContext, slot: string, bone: string, step: (e: Edit<Skeleton>) => void): void {
  const doc = docOf(ctx), s = doc.slots?.find((x) => x.name === slot);
  if (!s) throw new AgentRefused(`There is no slot "${slot}".`);
  if (s.bone === bone) return;
  const worlds = setupWorlds(ctx), from = worlds.get(s.bone)!.world, to = worlds.get(bone)!.world;
  const refs: AttachmentRef[] = (doc.skins ?? []).flatMap((k) => (k.attachments ?? []).filter((ss) => ss.slot === slot).flatMap((ss) => ss.entries.map((e) => ({ skin: k.name, slot, key: e.key }))));
  step((d) => {
    let out = updateSlot(slot, { bone })(d);
    for (const r of refs) out = replaceAttachment(out, r, reexpress(findAttachment(out, r)!, from, to));
    return out;
  });
}

function attach(args: Args, ctx: AgentContext) {
  const items = args.items as AttachArg[];
  return inStep(ctx, `attach ${items.length} picture${items.length === 1 ? "" : "s"}`, (step) => {
    const done: Record<string, unknown>[] = [], notes: string[] = [];
    for (const it of items) {
      const doc = docOf(ctx);
      boneOf(doc, it.bone);
      if ((it.image === undefined) === (it.layer === undefined)) throw new AgentRefused("Each item names an `image` (an atlas image to add) or a `layer` (a slot to move), one of the two.");
      if (it.layer !== undefined) {
        moveSlotOnto(ctx, it.layer, it.bone, step);
        if (it.pivot) notes.push(`${it.layer}: a picture turns about its bone in Spine; pivot is not used for a slot.`);
        done.push({ slot: it.layer, bone: it.bone });
        continue;
      }
      const region = ctx.images.regions.find((r) => r.name === it.image);
      if (!region) throw new AgentRefused(`There is no atlas image "${it.image}"; get_rig lists the images.`);
      const W = region.originalWidth, H = region.originalHeight, scale = it.scale ?? 1;
      const bone = setupWorlds(ctx).get(it.bone)!.world;
      const [pu, pv] = it.pivot ?? [W / 2, H / 2], at = it.at ?? [bone[4]!, bone[5]!], rot = ((it.rotation ?? 0) * Math.PI) / 180;
      const cx = (W / 2 - pu) * scale, cy = (pv - H / 2) * scale;
      const centre: Point = [at[0] + cx * Math.cos(rot) - cy * Math.sin(rot), at[1] + cx * Math.sin(rot) + cy * Math.cos(rot)];
      const [x, y] = toLocal(bone, centre[0], centre[1]);
      const name = unique(it.name ?? it.image!, (n) => !!doc.slots?.some((s) => s.name === n));
      // In front of what the bone already holds; on a bone holding nothing, in front of everything.
      const slots = doc.slots ?? [], last = slots.map((s) => s.bone).lastIndexOf(it.bone);
      step(addSlot(name, it.bone, last < 0 ? slots.length : last + 1));
      step(addRegion({ skin: "default", slot: name, key: it.image! }, {
        width: W, height: H, ...placed({ x: r2(x), y: r2(y), rotation: r2((it.rotation ?? 0) - deg(bone)) }),
        ...(scale !== 1 ? { scaleX: scale, scaleY: scale } : {}),
      }));
      step(updateSlot(name, { attachment: it.image! }));
      done.push({ slot: name, bone: it.bone, image: it.image });
    }
    return { attached: done, ...(notes.length ? { notes } : {}) };
  });
}

// ── IK and drawing order ──

function addIk(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), bone = boneOf(doc, String(args.bone));
  const parent = bone.parent !== undefined ? doc.bones!.find((b) => b.name === bone.parent) : undefined;
  const chain = parent ? [parent.name, bone.name] : [bone.name];
  for (const a of doc.animations ?? []) {
    const keyed = (a.bones ?? []).find((g) => chain.includes(g.name) && g.timelines.some((t) => t.keys.length));
    if (keyed) throw new AgentRefused(`"${keyed.name}" has keys in "${a.name}": the bones an IK turns are never keyed (key the target). delete_keys first.`);
  }
  const name = String(args.name ?? unique(`${bone.name}_ik`, (n) => !!doc.constraints?.some((c) => c.type === "ik" && c.name === n)));
  let target = args.target as string | undefined;
  if (target !== undefined) {
    boneOf(doc, target);
    if (chain.includes(target)) throw new AgentRefused(`The target "${target}" is in the chain it would pull.`);
  }
  return inStep(ctx, `add_ik ${name}`, (step) => {
    if (target === undefined) {
      const w = setupWorlds(ctx), b = w.get(bone.name)!, [a, , c, , x, y] = b.world as number[];
      const tip: Point = [x! + a! * b.length, y! + c! * b.length];
      const root = doc.bones!.find((x2) => x2.parent === undefined)!;
      const rootWorld = w.get(root.name)!.world, [lx, ly] = toLocal(rootWorld, tip[0], tip[1]);
      target = unique(`${bone.name}_target`, (n) => !!docOf(ctx).bones?.some((x2) => x2.name === n));
      step(addBone(target, root.name, placed({ x: r2(lx), y: r2(ly) })));
    }
    const scaleY = args.scale_y as string | undefined;
    step(addConstraint({
      type: "ik", name, bones: chain, target, extra: new Map(),
      ...(args.bendPositive === false ? { bendPositive: false } : {}),
      ...(args.mix !== undefined && args.mix !== 1 ? { mix: args.mix as number } : {}),
      ...(args.stretch ? { stretch: true } : {}), ...(args.compress ? { compress: true } : {}),
      ...(scaleY && scaleY !== "none" ? { scaleY } : {}),
    } as Constraint));
    return { ik: name, bones: chain, target };
  });
}

/** The slots a name stands for: a slot itself, or every slot on a bone and under it. */
function slotsOf(doc: Skeleton, name: string): string[] {
  const slots = doc.slots ?? [];
  if (slots.some((s) => s.name === name)) return [name];
  const under = new Set([name]);
  for (const b of doc.bones ?? []) if (b.parent !== undefined && under.has(b.parent)) under.add(b.name);
  return slots.filter((s) => under.has(s.bone)).map((s) => s.name);
}

/** The setup draw order with `front`'s groups (front first) moved into the places their slots held. */
export function drawOrderWith(slots: readonly string[], groups: readonly (readonly string[])[]): string[] {
  const all = new Set(groups.flat());
  const places = slots.map((s, i) => (all.has(s) ? i : -1)).filter((i) => i >= 0);
  // Back to front: the last group listed takes the first places; each keeps its own order.
  const ordered = [...groups].reverse().flatMap((g) => slots.filter((s) => g.includes(s)));
  const out = [...slots];
  places.forEach((p, j) => { out[p] = ordered[j]!; });
  return out;
}

function drawOrder(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), parent = args.parent as string | undefined, front = args.front as string[];
  if (parent !== undefined) boneOf(doc, parent);
  const groups = front.map((n) => {
    const b = doc.bones?.find((x) => x.name === n), s = doc.slots?.find((x) => x.name === n);
    if (!b && !s) throw new AgentRefused(`There is no bone or slot "${n}".`);
    const under = b ? b.parent : s!.bone;
    if (parent === undefined ? (b ? b.parent !== undefined : true) : under !== parent) throw new AgentRefused(`"${n}" is not a child of ${parent === undefined ? "the skeleton (a root bone)" : `"${parent}"`}.`);
    const own = slotsOf(doc, n);
    if (!own.length) throw new AgentRefused(`"${n}" has no slot on it or under it to draw.`);
    return own;
  });
  const slots = (doc.slots ?? []).map((s) => s.name), order = drawOrderWith(slots, groups);
  const edits: Edit<Skeleton>[] = order.map((name, i) => moveSlot(name, i));
  applyEdit(ctx, `draw_order ${front.join(", ")}`, (s) => edits.reduce((d, e) => e(d), s));
  return { order: [...order].reverse() };
}

// ── constraints ──

const PROPS = ["rotate", "x", "y", "scaleX", "scaleY", "shearY"] as const;
const MIX: Record<string, string> = { rotate: "mixRotate", x: "mixX", y: "mixY", scaleX: "mixScaleX", scaleY: "mixScaleY", shearY: "mixShearY" };
const OFFSET: Record<string, string> = { rotate: "rotation", x: "x", y: "y", scaleX: "scaleX", scaleY: "scaleY", shearY: "shearY" };

function keyed(o: Record<string, number> | undefined, map: Record<string, string>, what: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(o ?? {})) {
    if (!map[k]) throw new AgentRefused(`${what}.${k} is not one of ${Object.keys(map).join(", ")}.`);
    out[map[k]] = v;
  }
  return out;
}

function addTransform(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), bones = args.bones as string[], source = String(args.source);
  for (const b of [...bones, source]) boneOf(doc, b);
  if (bones.includes(source)) throw new AgentRefused(`"${source}" cannot follow itself.`);
  const name = String(args.name ?? unique(`${bones[0]}_transform`, (n) => !!doc.constraints?.some((c) => c.type === "transform" && c.name === n)));
  const mixes = keyed(args.mix as Record<string, number> | undefined, MIX, "mix");
  for (const v of Object.values(mixes)) if (!(v >= 0 && v <= 1)) throw new AgentRefused("A mix is from 0 to 1.");
  // Spine 4.3 moves only what the property map names: every property follows its own.
  const properties: TransformFrom[] = PROPS.map((p) => ({ from: p, to: [{ to: p, extra: new Map() }], extra: new Map() }));
  applyEdit(ctx, `add_transform_constraint ${name}`, addConstraint({
    type: "transform", name, bones, source, properties, extra: new Map(),
    ...Object.fromEntries(Object.entries(mixes).filter(([, v]) => v !== 1)), ...keyed(args.offsets as Record<string, number> | undefined, OFFSET, "offsets"),
    ...(args.localSource ? { localSource: true } : {}), ...(args.localTarget ? { localTarget: true } : {}),
    ...(args.relative ? { additive: true } : {}), ...(args.clamp ? { clamp: true } : {}),
  } as Constraint));
  return { constraint: name, bones, source };
}

/** A transform constraint's property map as the tools show it. */
const mapOf = (props: readonly TransformFrom[]) => Object.fromEntries(props.map((f) => [f.from, {
  ...(f.offset ? { offset: f.offset } : {}),
  to: Object.fromEntries((f.to ?? []).map((t) => [t.to, { scale: t.scale ?? 1, offset: t.offset ?? 0, max: t.max ?? 1 }])),
}]));

function mapTransform(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), name = String(args.constraint), from = String(args.from), to = String(args.to);
  const c = doc.constraints?.find((k) => k.type === "transform" && k.name === name);
  if (!c || c.type !== "transform") throw new AgentRefused(`There is no transform constraint "${name}".`);
  for (const p of [from, to]) if (!(PROPS as readonly string[]).includes(p)) throw new AgentRefused(`"${p}" is not one of ${PROPS.join(", ")}.`);
  let props = [...(c.properties ?? [])];
  const fi = props.findIndex((f) => f.from === from);
  const f: TransformFrom = fi >= 0 ? props[fi]! : { from, to: [], extra: new Map() };
  let tos = [...(f.to ?? [])];
  if (args.remove === true) {
    if (!tos.some((t) => t.to === to)) throw new AgentRefused(`"${from}" does not drive "${to}" in "${name}".`);
    tos = tos.filter((t) => t.to !== to);
  } else {
    const ti = tos.findIndex((t) => t.to === to), t0 = ti >= 0 ? tos[ti]! : { to, extra: new Map() };
    const t = { ...t0, ...Object.fromEntries((["scale", "offset", "max"] as const).filter((k) => args[k] !== undefined).map((k) => [k, args[k]])) };
    tos = ti >= 0 ? tos.map((x, i) => (i === ti ? t : x)) : [...tos, t];
  }
  const nf = { ...f, to: tos, ...(args.sourceOffset !== undefined ? { offset: args.sourceOffset as number } : {}) };
  props = fi >= 0 ? props.map((x, i) => (i === fi ? nf : x)) : [...props, nf];
  // A from that drives nothing is dropped, as Spine's reader drops it.
  props = props.filter((x) => (x.to ?? []).length);
  applyEdit(ctx, `map_transform ${name} ${from} → ${to}`, updateConstraint({ type: "transform", name }, { properties: props }));
  return { constraint: name, map: mapOf(props) };
}

const PHYSICS = ["x", "y", "rotate", "scaleX", "shearX", "inertia", "strength", "damping", "mass", "wind", "gravity", "mix", "limit", "fps"];

function addPhysics(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), bone = boneOf(doc, String(args.bone)).name, settings = (args.settings ?? {}) as Record<string, number>;
  const bad = Object.keys(settings).find((k) => !PHYSICS.includes(k));
  if (bad) throw new AgentRefused(`settings.${bad} is not one of ${PHYSICS.join(", ")}.`);
  const name = unique(`${bone}_physics`, (n) => !!doc.constraints?.some((c) => c.type === "physics" && c.name === n));
  applyEdit(ctx, `add_physics ${name}`, addConstraint({ type: "physics", name, bone, rotate: 1, ...settings, extra: new Map() } as Constraint));
  return { constraint: name, bone, settings: { rotate: 1, ...settings } };
}

function addSlider(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), animation = String(args.animation);
  if (!doc.animations?.some((a) => a.name === animation)) throw new AgentRefused(`There is no animation "${animation}".`);
  const bone = args.bone as string | undefined;
  if (bone !== undefined) boneOf(doc, bone);
  const name = unique(`${animation}_slider`, (n) => !!doc.constraints?.some((c) => c.type === "slider" && c.name === n));
  const fields = Object.fromEntries((["from", "to", "scale", "time", "mix", "loop", "additive", "local"] as const).filter((k) => args[k] !== undefined).map((k) => [k, args[k]]));
  applyEdit(ctx, `add_slider ${name}`, addConstraint({
    type: "slider", name, animation, ...(bone !== undefined ? { bone, property: (args.property as string | undefined) ?? "rotate" } : {}), ...fields, extra: new Map(),
  } as Constraint));
  return { constraint: name, animation, ...(bone !== undefined ? { bone } : {}) };
}

function setConstraintOrder(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), order = args.order as string[], list = doc.constraints ?? [];
  const missing = order.filter((n) => !list.some((c) => c.name === n));
  if (missing.length) throw new AgentRefused(`There is no constraint ${missing.map((n) => `"${n}"`).join(", ")}.`);
  const named = order.map((n) => list.find((c) => c.name === n)!), rest = list.filter((c) => !named.includes(c));
  const next = [...named, ...rest];
  applyEdit(ctx, "set_constraint_order", (s) => next.reduce((d, c, i) => moveConstraint({ type: c.type, name: c.name }, i)(d), s));
  return { constraintOrder: next.map((c) => c.name) };
}

// ── paths, boxes, points ──

function makePath(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), bones = (args.bones as string[]).map((n) => boneOf(doc, n));
  const host = bones[0]!.parent ?? doc.bones!.find((b) => b.parent === undefined)!.name;
  const slot = unique(`${bones[0]!.name}_path`, (n) => !!doc.slots?.some((s) => s.name === n));
  const name = unique(`${bones[0]!.name}_path`, (n) => !!doc.constraints?.some((c) => c.type === "path" && c.name === n));
  return inStep(ctx, `make_path ${name}`, (step) => {
    const w = setupWorlds(ctx), hostM = w.get(host)!.world;
    const pts: Point[] = bones.map((b) => { const m = w.get(b.name)!.world; return [m[4]!, m[5]!] as const; });
    const last = w.get(bones.at(-1)!.name)!;
    pts.push([last.world[4]! + last.world[0]! * last.length, last.world[5]! + last.world[2]! * last.length]);
    // Handles a third of the way towards the neighbours (the ends towards their one neighbour).
    const vertices: number[] = [], lengths: number[] = [];
    pts.forEach((p, i) => {
      const a = pts[Math.max(0, i - 1)]!, b = pts[Math.min(pts.length - 1, i + 1)]!, span = i === 0 || i === pts.length - 1 ? 1 : 2;
      const tx = (b[0] - a[0]) / span / 3, ty = (b[1] - a[1]) / span / 3;
      for (const [x, y] of [[p[0] - tx, p[1] - ty], p, [p[0] + tx, p[1] + ty]] as const) { const [lx, ly] = toLocal(hostM, x, y); vertices.push(r2(lx), r2(ly)); }
    });
    for (let i = 0; i + 1 < pts.length; i++) lengths.push(r2(Math.hypot(pts[i + 1]![0] - pts[i]![0], pts[i + 1]![1] - pts[i]![1])));
    step(addSlot(slot, host));
    step(addAttachment({ skin: "default", slot, key: slot }, { type: "path", constantSpeed: true, vertexCount: pts.length * 3, vertices, lengths, extra: new Map() } as Attachment));
    step(updateSlot(slot, { attachment: slot }));
    step(addConstraint({ type: "path", name, bones: bones.map((b) => b.name), slot, spacingMode: "length", rotateMode: "chainScale", extra: new Map() } as Constraint));
    return { constraint: name, slot, points: pts.length };
  });
}

function addAttachmentTool(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), kind = String(args.kind), on = args.on as string | undefined;
  const slotOn = on !== undefined ? doc.slots?.find((s) => s.name === on) : undefined;
  if (on !== undefined && !slotOn && !doc.bones?.some((b) => b.name === on)) throw new AgentRefused(`There is no slot or bone "${on}".`);
  const bone = slotOn ? slotOn.bone : on ?? doc.bones!.find((b) => b.parent === undefined)!.name;
  const name = unique(String(args.name ?? (kind === "box" ? "box" : "point")), (n) => !!doc.slots?.some((s) => s.name === n));
  let a: Attachment;
  if (kind === "box") {
    let corners = [-20, 20, 20, 20, 20, -20, -20, -20];
    const pic = slotOn?.attachment ? findAttachment(doc, { skin: "default", slot: slotOn.name, key: slotOn.attachment }) : undefined;
    if (pic && attachmentType(pic) === "region") {
      // The picture's rectangle, in its bone's space.
      const hw = ((pic.width ?? 0) * (pic.scaleX ?? 1)) / 2, hh = ((pic.height ?? 0) * (pic.scaleY ?? 1)) / 2, r = ((pic.rotation ?? 0) * Math.PI) / 180;
      corners = ([[-hw, hh], [hw, hh], [hw, -hh], [-hw, -hh]] as const).flatMap(([x, y]) => [r2((pic.x ?? 0) + x * Math.cos(r) - y * Math.sin(r)), r2((pic.y ?? 0) + x * Math.sin(r) + y * Math.cos(r))]);
    }
    a = { type: "boundingbox", vertexCount: 4, vertices: corners, extra: new Map() } as Attachment;
  } else {
    const pic = slotOn?.attachment ? findAttachment(doc, { skin: "default", slot: slotOn.name, key: slotOn.attachment }) : undefined;
    a = { type: "point", ...(pic ? placed({ x: pic.x ?? 0, y: pic.y ?? 0 }) : {}), extra: new Map() } as Attachment;
  }
  const slots = doc.slots ?? [], at = slotOn ? slots.indexOf(slotOn) + 1 : slots.length;
  applyEdit(ctx, `add_attachment ${kind} ${name}`, (s) => {
    let out = addSlot(name, bone, at)(s);
    out = addAttachment({ skin: "default", slot: name, key: name }, a)(out);
    return updateSlot(name, { attachment: name })(out);
  });
  return { kind, slot: name, bone };
}

function setPoint(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), want = String(args.point);
  for (const k of doc.skins ?? []) for (const ss of k.attachments ?? []) for (const e of ss.entries) {
    if (attachmentType(e.attachment) !== "point" || (e.key !== want && ss.slot !== want)) continue;
    const patch = Object.fromEntries((["x", "y", "rotation"] as const).filter((f) => args[f] !== undefined).map((f) => [f, args[f] as number]));
    applyEdit(ctx, `set_point ${e.key}`, updateAttachment({ skin: k.name, slot: ss.slot, key: e.key }, patch));
    const p = findAttachment(docOf(ctx), { skin: k.name, slot: ss.slot, key: e.key })!;
    return { point: e.key, slot: ss.slot, x: p.x ?? 0, y: p.y ?? 0, rotation: p.rotation ?? 0 };
  }
  throw new AgentRefused(`There is no point attachment "${want}".`);
}

// ── auto_rig ──

function autoRig(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), view = (args.view ?? "side") as MotionView, worlds = setupWorlds(ctx);
  const root = doc.bones?.find((b) => b.parent === undefined)?.name;
  const regions = new Map(ctx.images.regions.map((r) => [r.name, r]));
  // The pictures to rig: the slots on the root (a dropped PSD's layers), or those named.
  const named = args.layers as string[] | undefined;
  const candidates = (doc.slots ?? []).filter((s) => (named ? named.includes(s.name) : s.bone === root));
  const missing = named?.filter((n) => !doc.slots?.some((s) => s.name === n)) ?? [];
  if (missing.length) throw new AgentRefused(`There is no slot ${missing.map((n) => `"${n}"`).join(", ")}.`);
  const pictures: RigPicture[] = [];
  for (const s of candidates) {
    const a = s.attachment ? findAttachment(doc, { skin: "default", slot: s.name, key: s.attachment }) : undefined;
    const r = a ? regions.get(a.path ?? a.name ?? s.attachment!) : undefined;
    if (!a || attachmentType(a) !== "region" || !r) continue;
    const p = regionPlace(a, { width: r.originalWidth, height: r.originalHeight }, worlds.get(s.bone)!);
    pictures.push({ name: s.name, size: [r.originalWidth, r.originalHeight], pivot: p.pivot as [number, number], at: p.at as unknown as Point, rotation: p.rotation });
  }
  const plan = autoRigPlan(args.joints as Record<string, Point>, pictures, view, {
    armIk: args.armIk === true, taken: (n) => !!doc.bones?.some((b) => b.name === n) || !!doc.slots?.some((s) => s.name === n),
  });
  if (typeof plan === "string") throw new AgentRefused(plan);
  const facing = (args.facing ?? "right") as string;
  return inStep(ctx, `auto_rig ${plan.bones.length} bones`, (step) => {
    for (const b of plan.bones) {
      const parent = b.parent === null ? (root ? setupWorlds(ctx).get(root)!.world : IDENTITY) : setupWorlds(ctx).get(b.parent)!.world;
      step(addBone(b.name, b.parent ?? root ?? null, placed(localBone(parent, b.from, b.to))));
    }
    for (const a of plan.attach) moveSlotOnto(ctx, a.picture, a.bone, step);
    const iks: string[] = [];
    for (const shin of plan.ik) {
      const bone = docOf(ctx).bones!.find((b) => b.name === shin)!;
      const w = setupWorlds(ctx), m = w.get(shin)!.world, len = w.get(shin)!.length;
      const tip: Point = [m[4]! + m[0]! * len, m[5]! + m[2]! * len];
      const rootName = root ?? docOf(ctx).bones!.find((b) => b.parent === undefined)!.name;
      const [lx, ly] = toLocal(w.get(rootName)!.world, tip[0], tip[1]);
      const target = `${shin}_target`, name = `${shin}_ik`;
      step(addBone(target, rootName, placed({ x: r2(lx), y: r2(ly) })));
      // Where the joint is drawn, before the IK solves the chain.
      const drawn: Point = [m[4]!, m[5]!];
      step(addConstraint({ type: "ik", name, bones: [bone.parent!, shin], target, extra: new Map() } as Constraint));
      // Knees bend forward, elbows back, for a side view's facing; front views keep the default.
      const sign = facing === "left" ? -1 : 1;
      settleBend(ctx, step, name, shin, target, drawn, view === "front" ? null : /^shin/.test(shin) ? sign : -sign);
      iks.push(name);
    }
    return { bones: plan.bones.map((b) => b.name), attached: plan.attach.map((a) => ({ slot: a.picture, bone: a.bone })), ik: iks, ...(plan.notes.length ? { notes: plan.notes } : {}) };
  });
}

/**
 * Settle an IK's bend (E5 step 5): a bent limb keeps the bend it was drawn with (`drawn`, the
 * joint before the IK solved it: the bend that leaves it there); a straight one bends its joint
 * towards `forward` (+1: +x, −1: −x), found by pulling the target in and looking which way the
 * joint goes. Steps inside the caller's gesture; the target ends where it was.
 */
function settleBend(ctx: AgentContext, step: (e: Edit<Skeleton>) => void, ik: string, child: string, target: string, drawn: Point, forward: number | null): void {
  const joint = () => { const m = setupWorlds(ctx).get(child)!.world; return [m[4]!, m[5]!] as const; };
  const flip = () => {
    const now = docOf(ctx).constraints!.find((c) => c.type === "ik" && c.name === ik) as { bendPositive?: boolean };
    step(updateConstraint({ type: "ik", name: ik }, { bendPositive: now.bendPositive === false ? undefined : false }));
  };
  const parentOf = (n: string) => docOf(ctx).bones!.find((b) => b.name === n)!.parent!;
  const at = joint();
  // Bent as drawn: keep that bend (flip when the solve moved the joint).
  if (Math.hypot(at[0] - drawn[0], at[1] - drawn[1]) > 0.5) { flip(); return; }
  // Bent and kept by the default: done. Straight: the facing decides.
  const root0 = setupWorlds(ctx).get(parentOf(child))!.world, tip0 = setupWorlds(ctx).get(target)!.world;
  const ax = tip0[4]! - root0[4]!, ay = tip0[5]! - root0[5]!, off = Math.abs((drawn[0] - root0[4]!) * ay - (drawn[1] - root0[5]!) * ax) / (Math.hypot(ax, ay) || 1);
  if (forward === null || off > 0.5) return;
  // Straight (or bent as drawn either way): pull the target a fifth of the way to the chain's root and look.
  const t = docOf(ctx).bones!.find((b) => b.name === target)!, start = { x: t.x ?? 0, y: t.y ?? 0 };
  const w = setupWorlds(ctx), root = w.get(parentOf(child))!.world, tm = w.get(target)!.world, tParent = w.get(t.parent!)!.world;
  const pulled: Point = [tm[4]! + (root[4]! - tm[4]!) * 0.2, tm[5]! + (root[5]! - tm[5]!) * 0.2];
  const [px, py] = toLocal(tParent, pulled[0], pulled[1]);
  step(updateBone(target, { x: r2(px), y: r2(py) }));
  const bent = joint(), dx = bent[0] - root[4]!, along = [pulled[0] - root[4]!, pulled[1] - root[5]!] as const;
  // The joint's side of the root→target line, measured along x as the facing.
  const side = dx - (along[0] * ((bent[0] - root[4]!) * along[0] + (bent[1] - root[5]!) * along[1])) / (along[0] ** 2 + along[1] ** 2 || 1);
  step(updateBone(target, { x: start.x || undefined, y: start.y || undefined }));
  if (Math.sign(side) !== forward && Math.abs(side) > 1e-3) flip();
}

export const BUILD_TOOLS = {
  add_bones: addBones,
  attach,
  add_ik: addIk,
  draw_order: drawOrder,
  auto_rig: autoRig,
  add_transform_constraint: addTransform,
  map_transform: mapTransform,
  add_physics: addPhysics,
  add_slider: addSlider,
  make_path: makePath,
  set_constraint_order: setConstraintOrder,
  set_point: setPoint,
  add_attachment: addAttachmentTool,
} as const;
