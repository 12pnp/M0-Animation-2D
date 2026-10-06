import type { Shape } from "@/edit/curves";
import { orderOf } from "@/edit/drawOrder";
import { boneNumber } from "@/model/defaults";
import { type Animation, type Attachment, attachmentType, type Key, type Skeleton } from "@/model/skeleton";
import { animationDuration, DEFAULT_FPS, frameTime, keyLists, keyTime, timeFrame } from "@/model/timelines";
import { AI_EASES } from "./eases";
import { type AgentContext, AgentRefused, IMAGES_KEY, type PosedBone } from "./context";

/**
 * The read tools (E5-PLAN step 3): what an AI sees of the rig, and `show`, which turns the
 * editor to what it means. Values follow the contract: local and absolute for keys and setup
 * poses, y up, degrees counter-clockwise.
 */

type Args = Record<string, unknown>;

const r3 = (n: number) => { const v = Math.round(n * 1000) / 1000; return v === 0 ? 0 : v; };
const deg = (rad: number) => r3((rad * 180) / Math.PI);

export function fpsOf(doc: Skeleton): number {
  const f = doc.header?.fps;
  return f && f > 0 ? f : DEFAULT_FPS;
}

export function docOf(ctx: AgentContext): Skeleton {
  if (!ctx.history) throw new AgentRefused("Nothing is open in the editor: open a skeleton (or drop a PSD) first.");
  return ctx.history.doc;
}

export function animationOf(doc: Skeleton, name: unknown): Animation {
  const a = doc.animations?.find((x) => x.name === name);
  if (!a) {
    const names = (doc.animations ?? []).map((x) => x.name);
    throw new AgentRefused(`There is no animation "${String(name)}"${names.length ? `; the rig has ${names.join(", ")}` : "; the rig has none yet"}.`);
  }
  return a;
}

/** World values of a posed bone: position, rotation, and the scale of each axis. */
function world(b: PosedBone) {
  const [a, bb, c, d, x, y] = b.world as [number, number, number, number, number, number];
  return { x: r3(x), y: r3(y), rotation: deg(Math.atan2(c, a)), scaleX: r3(Math.hypot(a, c)), scaleY: r3(Math.sign(a * d - bb * c || 1) * Math.hypot(bb, d)) };
}

const lastFrame = (a: Animation, fps: number) => timeFrame(animationDuration(a), fps);

// ── get_rig ──

/** Where a region's picture sits: the bone's origin as a pixel of it, and the picture's world rotation. */
export function regionPlace(a: Attachment, pixels: { width: number; height: number }, bone: PosedBone) {
  const W = pixels.width, H = pixels.height;
  const sx = ((a.width ?? W) / W) * (a.scaleX ?? 1), sy = ((a.height ?? H) / H) * (a.scaleY ?? 1);
  const r = ((a.rotation ?? 0) * Math.PI) / 180, x = a.x ?? 0, y = a.y ?? 0;
  // The bone's origin in the picture's frame (centred, y up), then in its pixels (y down).
  const dx = -x * Math.cos(r) - y * Math.sin(r), dy = x * Math.sin(r) - y * Math.cos(r);
  const w = world(bone);
  return { pivot: [r3(W / 2 + dx / sx), r3(H / 2 - dy / sy)], at: [w.x, w.y], rotation: r3(w.rotation + (a.rotation ?? 0)) };
}

function getRig(_args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), fps = fpsOf(doc), view = ctx.view();
  const setup = new Map(ctx.pose(view.skin, null, 0).map((b) => [b.name, b]));
  const pixels = new Map(ctx.images.regions.map((r) => [r.name, { width: r.originalWidth, height: r.originalHeight }]));
  const skinAttachment = (slot: string, key: string) => {
    for (const skin of [view.skin, "default"]) {
      const e = doc.skins?.find((k) => k.name === skin)?.attachments?.find((x) => x.slot === slot)?.entries.find((x) => x.key === key);
      if (e) return e.attachment;
    }
    return undefined;
  };
  return {
    bones: (doc.bones ?? []).map((b) => {
      const p = setup.get(b.name);
      return {
        name: b.name, ...(b.parent !== undefined ? { parent: b.parent } : {}), length: boneNumber(b, "length"),
        setup: { x: boneNumber(b, "x"), y: boneNumber(b, "y"), rotation: boneNumber(b, "rotation"), scaleX: boneNumber(b, "scaleX"), scaleY: boneNumber(b, "scaleY"), shearX: boneNumber(b, "shearX"), shearY: boneNumber(b, "shearY") },
        ...(p ? { world: (({ x, y, rotation }) => ({ x, y, rotation }))(world(p)), ...(p.active ? {} : { active: false }) } : {}),
      };
    }),
    slots: (doc.slots ?? []).map((s) => {
      const a = s.attachment ? skinAttachment(s.name, s.attachment) : undefined;
      const out: Record<string, unknown> = { name: s.name, bone: s.bone };
      if (!a || !s.attachment) return out;
      const kind = attachmentType(a), image = a.path ?? a.name ?? s.attachment;
      out.attachment = s.attachment;
      out.kind = kind;
      if (kind === "region" || kind === "mesh" || kind === "linkedmesh") {
        const px = pixels.get(image);
        out.image = image;
        if (px) out.size = [px.width, px.height];
        const bone = setup.get(s.bone);
        if (kind === "region" && px && bone) Object.assign(out, regionPlace(a, px, bone));
      }
      return out;
    }),
    constraints: (doc.constraints ?? []).map((c) => {
      const o = c as unknown as Record<string, unknown>;
      const pick = (...ks: string[]) => Object.fromEntries(ks.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
      return { type: c.type, name: c.name, ...pick("bones", "target", "source", "slot", "bone", "animation", "skin") };
    }),
    constraintOrder: (doc.constraints ?? []).map((c) => c.name),
    images: ctx.images.regions.map((r) => ({ name: r.name, size: [r.originalWidth, r.originalHeight] })),
    skins: (doc.skins ?? []).map((k) => k.name),
    animations: (doc.animations ?? []).map((a) => ({ name: a.name, frames: lastFrame(a, fps) })),
    fps,
    shown: { animation: view.animation, frame: view.frame, skins: view.skin ? [view.skin] : [] },
    references: ctx.references().map((r) => r.path),
  };
}

// ── get_animation ──

/** A bone timeline's channels as the contract's properties, and how a stored value becomes the absolute one. */
const CHANNELS: Record<string, readonly { prop: string; field: "value" | "x" | "y"; setup: string; scale?: true }[]> = {
  rotate: [{ prop: "rotation", field: "value", setup: "rotation" }],
  translate: [{ prop: "x", field: "x", setup: "x" }, { prop: "y", field: "y", setup: "y" }],
  translatex: [{ prop: "x", field: "value", setup: "x" }],
  translatey: [{ prop: "y", field: "value", setup: "y" }],
  scale: [{ prop: "scaleX", field: "x", setup: "scaleX", scale: true }, { prop: "scaleY", field: "y", setup: "scaleY", scale: true }],
  scalex: [{ prop: "scaleX", field: "value", setup: "scaleX", scale: true }],
  scaley: [{ prop: "scaleY", field: "value", setup: "scaleY", scale: true }],
  shear: [{ prop: "shearX", field: "x", setup: "shearX" }, { prop: "shearY", field: "y", setup: "shearY" }],
  shearx: [{ prop: "shearX", field: "value", setup: "shearX" }],
  sheary: [{ prop: "shearY", field: "value", setup: "shearY" }],
};

const NAMED: readonly [string, Shape][] = Object.entries(AI_EASES);

/** The ease of channel `c` from key `k` to `next`: a name `set_keys` takes, or a normalised cubic. */
export function easeOf(k: Key, next: Key | undefined, c: number, stored: (key: Key) => number): string | number[] {
  if (k.curve === "stepped") return "hold";
  if (!Array.isArray(k.curve) || !next) return "linear";
  const b = k.curve.slice(c * 4, c * 4 + 4);
  if (b.length < 4) return "linear";
  const t0 = keyTime(k), t1 = keyTime(next), v0 = stored(k), v1 = stored(next);
  const dt = t1 - t0, dv = v1 - v0;
  // A flat channel shows no ease, whatever its handles say.
  if (!(dt > 0) || dv === 0) return "linear";
  const shape = [(b[0]! - t0) / dt, dv ? (b[1]! - v0) / dv : 0, (b[2]! - t0) / dt, dv ? (b[3]! - v0) / dv : 1].map((n) => Math.round(n * 1000) / 1000 || 0);
  if (Math.abs(shape[0]! - shape[1]!) < 0.005 && Math.abs(shape[2]! - shape[3]!) < 0.005) return "linear";
  const named = NAMED.find(([, p]) => p.every((v, i) => Math.abs(v - shape[i]!) < 0.01));
  return named ? named[0] : shape;
}

/** The bones whose local pose at the last frame differs from frame 0 (where the loop would hitch). */
function seamOf(ctx: AgentContext, skin: string | null, a: Animation): string[] {
  const end = animationDuration(a);
  if (!(end > 0)) return [];
  const at0 = ctx.pose(skin, a.name, 0), at1 = new Map(ctx.pose(skin, a.name, end).map((b) => [b.name, b]));
  return at0.filter((b) => { const e = at1.get(b.name); return e && b.local.some((v, i) => Math.abs(v - e.local[i]!) > 1e-3); }).map((b) => b.name);
}

function getAnimation(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), a = animationOf(doc, args.animation), fps = fpsOf(doc);
  const bones: Record<string, Record<string, unknown>[]> = {};
  for (const { path, keys } of keyLists(a)) {
    if (path.section !== "bones" || !("owner" in path) || !("timeline" in path)) continue;
    const chans = CHANNELS[path.timeline], bone = doc.bones?.find((b) => b.name === path.owner);
    if (!chans || !bone) continue;
    const rows = (bones[path.owner] ??= []);
    keys.forEach((k, i) => {
      const frame = timeFrame(keyTime(k), fps);
      let row = rows.find((r) => r.frame === frame);
      if (!row) { row = { frame, eases: {} }; rows.push(row); }
      chans.forEach((ch, c) => {
        const stored = (key: Key) => (key[ch.field] as number | undefined) ?? (ch.scale ? 1 : 0);
        const setup = boneNumber(bone, ch.setup as "x");
        row![ch.prop] = r3(ch.scale ? setup * stored(k) : setup + stored(k));
        (row!.eases as Record<string, unknown>)[ch.prop] = easeOf(k, keys[i + 1], c, stored);
      });
    });
  }
  for (const rows of Object.values(bones)) {
    rows.sort((x, y) => (x.frame as number) - (y.frame as number));
    for (const row of rows) {
      const eases = row.eases as Record<string, unknown>, all = Object.values(eases).map((e) => JSON.stringify(e));
      delete row.eases;
      if (all.every((e) => e === all[0])) row.ease = eases[Object.keys(eases)[0]!];
      else { row.ease = "linear"; row.eases = Object.fromEntries(Object.entries(eases).filter(([, e]) => JSON.stringify(e) !== JSON.stringify("linear"))); }
    }
  }
  const seam = seamOf(ctx, ctx.view().skin, a);
  return { animation: a.name, frames: lastFrame(a, fps), fps, bones, ...otherKeys(doc, a, fps), cycle: seam.length === 0, seam };
}

/** A constraint key's ease as key_ik and its kin take it: linear, stepped, smooth, or a cubic. */
function constraintEase(k: Key, next: Key | undefined, stored: (key: Key) => number): string | number[] {
  const e = easeOf(k, next, 0, stored);
  return e === "hold" ? "stepped" : e === "inout" ? "smooth" : e;
}

/** The keys the other key tools make: IK, transform, physics, slider and path constraints, draw order, events. */
function otherKeys(doc: Skeleton, a: Animation, fps: number) {
  const frame = (k: Key) => timeFrame(keyTime(k), fps);
  const out: Record<string, unknown[]> = {};
  const push = (list: string, v: unknown) => (out[list] ??= []).push(v);
  for (const { path, keys } of keyLists(a)) {
    if (path.section === "ik") {
      push("ik", { ik: path.owner, keys: keys.map((k, i) => ({ frame: frame(k), mix: k.mix ?? 1, bendPositive: k.bendPositive ?? true, softness: k.softness ?? 0, ease: constraintEase(k, keys[i + 1], (x) => x.mix ?? 1) })) });
    } else if (path.section === "transform") {
      push("transforms", { constraint: path.owner, keys: keys.map((k, i) => {
        const x = k.mixX ?? 1;
        return { frame: frame(k), mix: { rotate: k.mixRotate ?? 1, x, y: k.mixY ?? x, scaleX: k.mixScaleX ?? 1, scaleY: k.mixScaleY ?? 1, shearY: k.mixShearY ?? 1 }, ease: constraintEase(k, keys[i + 1], (y) => y.mixRotate ?? 1) };
      }) });
    } else if ((path.section === "physics" || path.section === "slider" || path.section === "path") && "timeline" in path) {
      const value = (k: Key) => (path.timeline === "mix" && path.section === "path" ? k.mixRotate ?? 1 : k.value ?? (path.timeline === "mix" || (path.section === "slider" && path.timeline === "time") ? 1 : 0));
      push("constraints", { type: path.section, constraint: path.owner === "" ? "(every physics constraint)" : path.owner, channel: path.timeline, keys: keys.map((k, i) => ({ frame: frame(k), ...(path.timeline === "reset" ? {} : { value: value(k), ease: constraintEase(k, keys[i + 1], value) }) })) });
    } else if (path.section === "drawOrder") {
      const slots = (doc.slots ?? []).map((x) => x.name);
      out.drawOrder = keys.map((k) => (k.offsets?.length ? { frame: frame(k), front: orderOf(slots, k.offsets).reverse() } : { frame: frame(k), setup: true }));
    } else if (path.section === "events") {
      out.events = keys.map((k) => ({ frame: frame(k), event: k.name, ...Object.fromEntries((["int", "float", "string", "volume", "balance"] as const).filter((f) => k[f] !== undefined).map((f) => [f, k[f]])) }));
    }
  }
  return out;
}

// ── get_pose ──

function getPose(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), fps = fpsOf(doc), view = ctx.view();
  const anim = args.animation !== undefined ? animationOf(doc, args.animation).name : null;
  const frame = (args.frame as number | undefined) ?? 0;
  const want = args.bones as string[] | undefined;
  const missing = want?.filter((n) => !doc.bones?.some((b) => b.name === n)) ?? [];
  if (missing.length) throw new AgentRefused(`There is no bone ${missing.map((n) => `"${n}"`).join(", ")}.`);
  const posed = ctx.pose(view.skin, anim, frameTime(frame, fps));
  const out: Record<string, unknown> = {};
  for (const b of posed) if ((!want || want.includes(b.name)) && b.active) out[b.name] = world(b);
  const inactive = posed.filter((b) => !b.active && (!want || want.includes(b.name))).map((b) => b.name);
  return { animation: anim, frame, skins: view.skin ? [view.skin] : [], bones: out, ...(inactive.length ? { inactive } : {}) };
}

// ── show ──

function show(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), a = animationOf(doc, args.animation), fps = fpsOf(doc), view = ctx.view();
  const frame = (args.frame as number | undefined) ?? 0, end = lastFrame(a, fps);
  if (frame > end) throw new AgentRefused(`"${a.name}" is ${end} frames long; show a frame from 0 to ${end}.`);
  let skin = view.skin;
  const skins = args.skins as string[] | undefined;
  if (skins) {
    if (skins.length > 1) throw new AgentRefused("The editor shows one skin over the default at a time: give one skin, or [] for the default alone.");
    const name = skins[0];
    if (name !== undefined && name !== "default" && !doc.skins?.some((k) => k.name === name)) throw new AgentRefused(`There is no skin "${name}"; the rig has ${(doc.skins ?? []).map((k) => k.name).join(", ")}.`);
    skin = name === undefined || name === "default" ? null : name;
  }
  ctx.show({ animation: a.name, frame, skin });
  return { shown: { animation: a.name, frame, skins: skin ? [skin] : [] } };
}

// ── get_reference ──

async function getReference(args: Args, ctx: AgentContext) {
  animationOf(docOf(ctx), args.animation);
  const refs = ctx.references();
  const out: Record<string, unknown> = {
    note: "A reference is a still picture placed in skeleton space and shown at every frame of every animation.",
    references: refs.map((r) => ({
      path: r.path, x: r.x, y: r.y, scale: r.scale, opacity: r.opacity,
      ...(r.width !== null && r.height !== null
        ? { size: [r.width, r.height], pixel: `pixel (u, v) is at (${r3(r.x - (r.width * r.scale) / 2)} + u·${r.scale}, ${r3(r.y + (r.height * r.scale) / 2)} − v·${r.scale})` }
        : { missing: "its picture's file was not opened with the rig" }),
    })),
  };
  if (args.frames !== undefined) {
    const images: { data: string; mimeType: string }[] = [];
    for (const r of refs.slice(0, 6)) { const png = await ctx.referencePicture(r.path); if (png) images.push({ data: png, mimeType: "image/png" }); }
    out[IMAGES_KEY] = images;
  }
  return out;
}

// ── render_frame ──

async function renderFrame(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), fps = fpsOf(doc), view = ctx.view();
  const anim = args.animation !== undefined ? animationOf(doc, args.animation) : null;
  const frame = (args.frame as number | undefined) ?? 0;
  const paths = (args.paths as string[] | undefined) ?? [];
  if (paths.length && !anim) throw new AgentRefused("paths needs an animation: a path is where a bone's tip goes over it.");
  const missing = paths.filter((n) => !doc.bones?.some((b) => b.name === n));
  if (missing.length) throw new AgentRefused(`There is no bone ${missing.map((n) => `"${n}"`).join(", ")}.`);
  const drawn: { bone: string; points: [number, number][]; keyed: number[] }[] = paths.map((bone) => ({ bone, points: [], keyed: [] }));
  if (anim && paths.length) {
    const end = lastFrame(anim, fps);
    const keyedFrames = (bone: string) => new Set(keyLists(anim).filter((l) => l.path.section === "bones" && "owner" in l.path && l.path.owner === bone).flatMap((l) => l.keys.map((k) => timeFrame(keyTime(k), fps))));
    const sets = new Map(paths.map((b) => [b, keyedFrames(b)]));
    for (let f = 0; f <= end; f++) {
      const posed = new Map(ctx.pose(view.skin, anim.name, frameTime(f, fps)).map((b) => [b.name, b]));
      for (const d of drawn) {
        const b = posed.get(d.bone)!, [a, , c, , x, y] = b.world as [number, number, number, number, number, number];
        d.points.push([x + a * b.length, y + c * b.length]);
        if (sets.get(d.bone)!.has(f)) d.keyed.push(f);
      }
    }
  }
  const pic = await ctx.render({ skin: view.skin, animation: anim?.name ?? null, time: frameTime(frame, fps), reference: args.reference !== false, bones: args.bones !== false, paths: drawn });
  return {
    animation: anim?.name ?? null, frame, size: [pic.width, pic.height],
    mapping: { scale: r3(pic.scale), origin: pic.origin.map(r3), formula: "skeleton (x, y) is at pixel (origin[0] + x·scale, origin[1] − y·scale)" },
    bones: pic.bones.map((b) => ({ name: b.name, joint: b.joint.map(Math.round), tip: b.tip.map(Math.round), ...(b.outside ? { outside: true } : {}) })),
    [IMAGES_KEY]: [{ data: pic.png, mimeType: "image/png" }],
  };
}

export const READ_TOOLS = {
  get_rig: getRig,
  get_animation: getAnimation,
  get_pose: getPose,
  show,
  get_reference: getReference,
  render_frame: renderFrame,
} as const;
