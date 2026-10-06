import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { addAnimation, deleteAnimation, renameAnimation } from "@/edit/animations";
import { type AttachmentRef, deleteAttachment, findAttachment, renameAttachment, updateAttachment } from "@/edit/attachments";
import { addBone, deleteBone, renameBone, reparentBone, updateBone } from "@/edit/bones";
import { type ConstraintRef, deleteConstraint, moveConstraint, renameConstraint, updateConstraint } from "@/edit/constraints";
import { defineEvent, deleteEvent, deleteEventKeys, keyEvent, renameEvent } from "@/edit/events";
import { setFps } from "@/edit/header";
import { type Edit, EditRefused, History } from "@/edit/history";
import { deleteKeys, type KeyRef, moveKeys, setChannelCurve, setCurve, setKey, setKeyCurve } from "@/edit/keys";
import { BONE_PROPERTIES, keyBone } from "@/edit/boneKeys";
import { CONSTRAINT_KEYS, keyConstraint } from "@/edit/constraintKeys";
import { keyDeform } from "@/edit/deformKeys";
import { addHullVertex, addVertex, deleteVertex, moveVertex, regionToMesh, retriangulate } from "@/edit/mesh";
import { decodeBinds, frameFor, positions } from "@/edit/meshLayout";
import { copyKeys, pasteKeys, pastePose } from "@/edit/paste";
import { PRESETS } from "@/edit/curves";
import { addSkin, deleteSkin, duplicateSkin, moveAttachment, renameSkin, setSkinColor, setSkinMember, SKIN_LISTS } from "@/edit/skins";
import { addSlot, deleteSlot, moveSlot, renameSlot, updateSlot } from "@/edit/slots";
import { autoWeights, bindMesh, setMeshBone, setWeight, setWeights, unbindMesh } from "@/edit/weights";
import { type AtlasImages, atlasImages } from "@/engine/regions";
import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import { profileIssues } from "@/model/profile";
import { CONSTRAINT_TYPES, type Skeleton } from "@/model/skeleton";
import { keyLists, keyTime } from "@/model/timelines";
import { newConstraint } from "@/ui/panels/newConstraint";
import { boneMatrix, Poser } from "@/ui/stage/posed";
import { SAMPLES } from "./fixtures/samples";

/**
 * Edits fuzzed (E7-PLAN step 4): on every corpus rig, seeded random sequences of the edit layer's
 * own edits, drawn from the document as it is at each step. After every step the document must
 * hold its invariants; at the end, undo and redo give back the very documents.
 * FUZZ_SEED=<n> runs one seed; FUZZ_STEPS=<n> runs longer; FUZZ_RIG=<part of a name> one rig.
 */

interface Rig { readonly name: string; readonly json: string; readonly atlas: string }

function corpus(): Rig[] {
  const out: Rig[] = [{ name: "stickman", json: join(__dirname, "fixtures", "stickman", "Stickman_IK.json"), atlas: join(__dirname, "fixtures", "stickman", "Stickman_IK.atlas.txt") }];
  if (!existsSync(SAMPLES)) throw new Error(`samples not found at ${SAMPLES}`);
  for (const d of readdirSync(SAMPLES, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const files = readdirSync(join(SAMPLES, d.name)), atlas = files.find((f) => /\.atlas(\.txt)?$/.test(f));
    if (!atlas) continue;
    for (const j of files.filter((f) => f.endsWith(".json"))) out.push({ name: `${d.name}/${j}`, json: join(SAMPLES, d.name, j), atlas: join(SAMPLES, d.name, atlas) });
  }
  return out;
}

/** mulberry32: small, seeded, the same on every machine. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One random edit, from the document as it is: its label (with its arguments) and the edit. */
type Op = { readonly label: string; readonly edit: Edit<Skeleton>; readonly target?: AttachmentRef; readonly renames?: readonly [string, string] };

function generator(rnd: () => number, images: AtlasImages) {
  const int = (n: number) => Math.floor(rnd() * n);
  const pick = <T>(xs: readonly T[]): T | undefined => (xs.length ? xs[int(xs.length)] : undefined);
  const chance = (p: number) => rnd() < p;
  let fresh = 0;
  /** A new name; sometimes an awkward one, or one that is taken. */
  const name = (taken: readonly string[]) => (chance(0.08) ? pick(["", " ", "名前", "a/b", "x".repeat(200)])! : chance(0.08) && taken.length ? pick(taken)! : `fz${fresh++}`);
  const num = () => (chance(0.05) ? pick([0, -0, 1e9, -1e9, 1e-9, NaN, Infinity])! : Math.round((rnd() * 400 - 200) * 100) / 100);
  const time = () => (chance(0.1) ? rnd() * 3 : int(60) / 30);
  /** The setup pose's bone matrices with `skin` shown, as the stage gives them to a mesh edit. */
  const worlds = (doc: Skeleton, skin = "default") => {
    const p = new Poser(doc, images).pose(skin === "default" ? null : skin, null, 0);
    return (doc.bones ?? []).map((b) => [...boneMatrix(p, p.bones.get(b.name)!)]);
  };

  return (doc: Skeleton): Op | null => {
    const bones = (doc.bones ?? []).map((b) => b.name), slots = (doc.slots ?? []).map((s) => s.name);
    const skins = (doc.skins ?? []).map((s) => s.name), anims = (doc.animations ?? []).map((a) => a.name);
    const events = (doc.events ?? []).map((e) => e.name);
    const constraints: ConstraintRef[] = (doc.constraints ?? []).map((c) => ({ type: c.type, name: c.name }));
    const atts: AttachmentRef[] = (doc.skins ?? []).flatMap((k) => (k.attachments ?? []).flatMap((s) => s.entries.map((e) => ({ skin: k.name, slot: s.slot, key: e.key }))));
    const fps = doc.header?.fps ?? 30;
    const bone = () => pick(bones) ?? "root", slot = () => pick(slots) ?? "none", anim = () => pick(anims) ?? "none";
    const att = () => pick(atts) ?? { skin: "default", slot: "none", key: "none" };
    const keyRefs = (a: string): KeyRef[] => {
      const an = doc.animations?.find((x) => x.name === a);
      if (!an) return [];
      const all = keyLists(an).flatMap((l) => l.keys.map((k) => ({ path: l.path, time: keyTime(k), ...(l.path.section === "events" && typeof k.name === "string" ? { name: k.name } : {}) })));
      return all.filter(() => chance(0.3)).slice(0, 8);
    };
    const ops: (() => Op | null)[] = [
      () => { const b = bone(), patch = { [pick(["x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY", "length"])!]: num() }; return { label: `updateBone ${b} ${JSON.stringify(patch)}`, edit: updateBone(b, patch) }; },
      () => { const n = name(bones), p = chance(0.1) ? null : bone(); return { label: `addBone ${n} under ${p}`, edit: addBone(n, p, { x: num(), y: num() }) }; },
      () => { const b = bone(); return { label: `deleteBone ${b}`, edit: deleteBone(b) }; },
      () => { const b = bone(), n = name(bones); return { label: `renameBone ${b} → ${n}`, edit: renameBone(b, n), renames: [b, n] }; },
      () => { const b = bone(), p = bone(); return { label: `reparentBone ${b} → ${p}`, edit: reparentBone(b, p) }; },
      () => { const n = name(slots), b = bone(); return { label: `addSlot ${n} on ${b}`, edit: addSlot(n, b) }; },
      () => { const s = slot(); return { label: `deleteSlot ${s}`, edit: deleteSlot(s) }; },
      () => { const s = slot(), n = name(slots); return { label: `renameSlot ${s} → ${n}`, edit: renameSlot(s, n) }; },
      () => { const s = slot(), c = pick(["ff0000ff", "00ff0080", "zz", "", undefined]); return { label: `updateSlot ${s} color ${c}`, edit: updateSlot(s, { color: c }) }; },
      () => { const s = slot(), to = int(slots.length + 2) - 1; return { label: `moveSlot ${s} → ${to}`, edit: moveSlot(s, to) }; },
      () => { const r = att(), n = name([]); return { label: `renameAttachment ${JSON.stringify(r)} → ${n}`, edit: renameAttachment(r, n) }; },
      () => { const r = att(); return { label: `deleteAttachment ${JSON.stringify(r)}`, edit: deleteAttachment(r) }; },
      () => { const r = att(), patch = { [pick(["x", "y", "rotation", "scaleX", "width"])!]: num() }; return { label: `updateAttachment ${JSON.stringify(r)} ${JSON.stringify(patch)}`, edit: updateAttachment(r, patch) }; },
      () => { const r = att(); return { label: `regionToMesh ${JSON.stringify(r)}`, edit: regionToMesh(r), target: r }; },
      () => { const r = att(), i = int(12); return { label: `moveVertex ${JSON.stringify(r)} ${i}`, edit: (d) => moveVertex(r, i, num(), num(), chance(0.5), worlds(d, r.skin))(d), target: r }; },
      () => {
        // Inside the mesh most of the time: a triangle's centre, in the slot's bone space.
        const r = att();
        return { label: `addVertex ${JSON.stringify(r)}`, target: r, edit: (d) => {
          const a = findAttachment(d, r), w = worlds(d, r.skin), tri = a?.triangles && a.uvs ? int(a.triangles.length / 3) : -1;
          if (tri < 0 || chance(0.2)) return addVertex(r, num() / 4, num() / 4, w)(d);
          const pos = positions(a!, frameFor(d, r, a!, w)), t = a!.triangles!.slice(tri * 3, tri * 3 + 3);
          return addVertex(r, (pos[t[0]! * 2]! + pos[t[1]! * 2]! + pos[t[2]! * 2]!) / 3, (pos[t[0]! * 2 + 1]! + pos[t[1]! * 2 + 1]! + pos[t[2]! * 2 + 1]!) / 3, w)(d);
        } };
      },
      () => { const r = att(), i = int(12); return { label: `deleteVertex ${JSON.stringify(r)} ${i}`, edit: (d) => deleteVertex(r, i, worlds(d, r.skin))(d), target: r }; },
      () => { const r = att(); return { label: `retriangulate ${JSON.stringify(r)}`, edit: (d) => retriangulate(r, worlds(d, r.skin))(d), target: r }; },
      () => { const r = att(), bs = [bone(), bone()]; return { label: `bindMesh ${JSON.stringify(r)} ${bs}`, edit: (d) => bindMesh(r, bs, worlds(d, r.skin))(d), target: r }; },
      () => { const r = att(); return { label: `autoWeights ${JSON.stringify(r)}`, edit: (d) => autoWeights(r, worlds(d, r.skin))(d), target: r }; },
      () => { const r = att(); return { label: `unbindMesh ${JSON.stringify(r)}`, edit: (d) => unbindMesh(r, worlds(d, r.skin))(d), target: r }; },
      () => { const r = att(), k = pick(skins) ?? "default"; return { label: `moveAttachment ${JSON.stringify(r)} → ${k}`, edit: moveAttachment(r, k) }; },
      () => { const n = name(skins); return { label: `addSkin ${n}`, edit: addSkin(n) }; },
      () => { const k = pick(skins) ?? "default"; return { label: `deleteSkin ${k}`, edit: deleteSkin(k) }; },
      () => { const k = pick(skins) ?? "default", n = name(skins); return { label: `renameSkin ${k} → ${n}`, edit: renameSkin(k, n) }; },
      () => { const k = pick(skins) ?? "default", n = name(skins); return { label: `duplicateSkin ${k} → ${n}`, edit: duplicateSkin(k, n) }; },
      () => { const k = pick(skins) ?? "default", c = pick(["ff8800ff", "bad", undefined]); return { label: `setSkinColor ${k} ${c}`, edit: setSkinColor(k, c) }; },
      () => {
        const k = pick(skins) ?? "default", list = pick(SKIN_LISTS)!, on = chance(0.6);
        const n = list === "bones" ? bone() : pick(constraints.filter((c) => c.type === list).map((c) => c.name)) ?? "none";
        return { label: `setSkinMember ${k} ${list} ${n} ${on}`, edit: setSkinMember(k, list, n, on) };
      },
      () => {
        const type = pick(CONSTRAINT_TYPES)!, from = { bone: chance(0.9) ? bone() : null, slot: chance(0.9) ? slot() : null, skin: null, animation: null };
        return { label: `newConstraint ${type} ${JSON.stringify(from)}`, edit: (d) => newConstraint(d, images, type, from).edit(d) };
      },
      () => {
        const r = pick(constraints);
        if (!r) return null;
        const c = doc.constraints!.find((x) => x.type === r.type && x.name === r.name)!;
        const fields = Object.entries(c).filter(([, v]) => typeof v === "number").map(([k]) => k);
        const f = pick(fields.length ? fields : ["mix"])!, v = chance(0.7) ? rnd() : num();
        return { label: `updateConstraint ${r.type} ${r.name} ${f}=${v}`, edit: updateConstraint(r, { [f]: v } as never) };
      },
      () => { const r = pick(constraints); if (!r) return null; const n = name(constraints.map((c) => c.name)); return { label: `renameConstraint ${r.name} → ${n}`, edit: renameConstraint(r, n) }; },
      () => { const r = pick(constraints); if (!r) return null; return { label: `deleteConstraint ${r.type} ${r.name}`, edit: deleteConstraint(r) }; },
      () => { const r = pick(constraints); if (!r) return null; const to = int(constraints.length + 2) - 1; return { label: `moveConstraint ${r.name} → ${to}`, edit: moveConstraint(r, to) }; },
      () => { const n = name(events), v = int(10); return { label: `defineEvent ${n} int=${v}`, edit: defineEvent(n, { int: v }) }; },
      () => { const e = pick(events) ?? "none", n = name(events); return { label: `renameEvent ${e} → ${n}`, edit: renameEvent(e, n) }; },
      () => { const e = pick(events) ?? "none"; return { label: `deleteEvent ${e}`, edit: deleteEvent(e) }; },
      () => { const a = anim(), t = time(), e = pick(events) ?? "none"; return { label: `keyEvent ${a} ${t} ${e}`, edit: keyEvent(a, t, e) }; },
      () => {
        // An event key that is there, most of the time.
        const a = anim(), keys = doc.animations?.find((x) => x.name === a)?.events ?? [], k = chance(0.8) ? pick(keys) : undefined;
        const t = k ? keyTime(k) : time(), e = k && typeof k.name === "string" ? k.name : pick(events) ?? "none";
        return { label: `deleteEventKeys ${a} ${t} ${e}`, edit: deleteEventKeys(a, t, e) };
      },
      () => { const n = name(anims); return { label: `addAnimation ${n}`, edit: addAnimation(n) }; },
      () => { const a = anim(); return { label: `deleteAnimation ${a}`, edit: deleteAnimation(a) }; },
      () => { const a = anim(), n = name(anims); return { label: `renameAnimation ${a} → ${n}`, edit: renameAnimation(a, n) }; },
      () => {
        const a = anim(), b = bone(), tl = pick(["rotate", "translate", "scale", "shear", "translatex", "scaley"])!, t = time();
        const fields = tl === "rotate" ? { value: num() } : tl.length > 7 ? { value: num() } : { x: num(), y: num() };
        return { label: `setKey ${a} ${b}.${tl} @${t} ${JSON.stringify(fields)}`, edit: setKey(a, { section: "bones", owner: b, timeline: tl }, t, fields) };
      },
      () => { const a = anim(), refs = keyRefs(a); return { label: `deleteKeys ${a} ×${refs.length}`, edit: deleteKeys(a, refs) }; },
      () => { const a = anim(), refs = keyRefs(a), by = int(11) - 5; return { label: `moveKeys ${a} ×${refs.length} by ${by}`, edit: moveKeys(a, refs, by, fps) }; },
      () => { const a = anim(), refs = keyRefs(a).filter((r) => r.path.section !== "events" && r.path.section !== "drawOrder"), c = pick(["linear", "stepped", "easeIn", "easeInOut"] as const)!; return { label: `setCurve ${a} ×${refs.length} ${c}`, edit: setCurve(a, refs, c === "linear" || c === "stepped" ? c : PRESETS[c]) }; },
      () => {
        const a = anim(), to = anim(), refs = keyRefs(a), f = int(40), an = doc.animations?.find((x) => x.name === a);
        if (!an || !refs.length) return null;
        return { label: `copy ${a} ×${refs.length} → paste ${to} @${f}`, edit: (d) => pasteKeys(to, copyKeys(an, refs, fps), f, fps).edit(d) };
      },
      () => { const f = pick([1, 24, 30, 60, 240, 0, 1000, 29.97, undefined]); return { label: `setFps ${f}`, edit: setFps(f) }; },
      // The weight brush, the weight fields, the outline handles, the stage's keys and pose paste, the curve graph.
      () => { const r = att(), b = bone(), on = chance(0.6); return { label: `setMeshBone ${JSON.stringify(r)} ${b} ${on}`, target: r, edit: (d) => setMeshBone(r, b, on, worlds(d, r.skin))(d) }; },
      () => { const r = att(), v = int(12), b = bone(), w = chance(0.8) ? rnd() : num(); return { label: `setWeight ${JSON.stringify(r)} ${v} ${b} ${w}`, target: r, edit: (d) => setWeight(r, v, b, w, worlds(d, r.skin))(d) }; },
      () => {
        const r = att(), b = bone(), ws = new Map(Array.from({ length: 1 + int(5) }, () => [int(12), chance(0.85) ? rnd() : num()] as [number, number]));
        return { label: `setWeights ${JSON.stringify(r)} ${b} ${JSON.stringify([...ws])}`, target: r, edit: (d) => setWeights(r, b, ws, worlds(d, r.skin))(d) };
      },
      () => { const r = att(), k = int(10), t = rnd(); return { label: `addHullVertex ${JSON.stringify(r)} ${k} ${t}`, target: r, edit: (d) => addHullVertex(r, k, t, worlds(d, r.skin))(d) }; },
      () => {
        const a = anim(), b = bone(), props = BONE_PROPERTIES.filter(() => chance(0.5)), t = time();
        const local = { x: num(), y: num(), rotation: num(), scaleX: chance(0.8) ? 1 + rnd() : num(), scaleY: 1, shearX: 0, shearY: chance(0.9) ? 0 : num() };
        return { label: `keyBone ${a} ${b} ${props} @${t} ${JSON.stringify(local)}`, edit: keyBone(a, b, props, local, t) };
      },
      () => {
        const a = chance(0.8) ? anim() : null, t = time(), local = { x: num(), y: num(), rotation: num(), scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 };
        const pose = { kind: "pose" as const, bones: new Map(bones.filter(() => chance(0.3)).map((n) => [n, local])) };
        return { label: `pastePose ${a} @${t} ×${pose.bones.size}`, edit: pastePose(pose, a, t, new Map(bones.map((n) => [n, { ...local, x: 0 }]))) };
      },
      () => {
        const r = pick(constraints);
        if (!r) return null;
        const fields = Object.keys(CONSTRAINT_KEYS[r.type]), f = pick(fields)!, v = chance(0.8) ? rnd() : num(), a = anim(), t = time();
        return { label: `keyConstraint ${a} ${r.type} ${r.name} ${f}=${v} @${t}`, edit: keyConstraint(a, r, f, v, {}, t) };
      },
      () => {
        const a = anim(), ref = pick(keyRefs(a).filter((k) => k.path.section !== "events" && k.path.section !== "drawOrder"));
        if (!ref) return null;
        const curve = chance(0.3) ? "stepped" as const : [PRESETS.easeIn, null];
        return { label: `setKeyCurve ${a} ${JSON.stringify(ref.path)} @${ref.time}`, edit: setKeyCurve(a, ref, curve) };
      },
      () => {
        const a = anim(), ref = pick(keyRefs(a).filter((k) => k.path.section !== "events" && k.path.section !== "drawOrder"));
        if (!ref) return null;
        const h: [number, number, number, number] = [ref.time + rnd() * 0.1, num(), ref.time + rnd() * 0.2, num()];
        return { label: `setChannelCurve ${a} ${JSON.stringify(ref.path)} @${ref.time} ${JSON.stringify(h)}`, edit: setChannelCurve(a, ref, int(2), h) };
      },
      () => {
        const r = att(), a = anim(), t = time(), at = doc.skins?.find((k) => k.name === r.skin)?.attachments?.find((x) => x.slot === r.slot)?.entries.find((e) => e.key === r.key)?.attachment;
        const n = at?.uvs ? at.uvs.length : 8 + int(4) * 2, offsets = Array.from({ length: chance(0.9) ? n : n + 2 }, () => (chance(0.97) ? num() / 10 : NaN));
        return { label: `keyDeform ${a} ${JSON.stringify(r)} @${t} ×${offsets.length}`, edit: keyDeform(a, r, t, offsets) };
      },
    ];
    return pick(ops)!();
  };
}

/** Each weighted attachment's bound bones, by name, keyed by skin, slot and attachment. */
function boundBones(doc: Skeleton): Map<string, string> {
  const out = new Map<string, string>();
  for (const k of doc.skins ?? []) for (const ss of k.attachments ?? []) for (const e of ss.entries) {
    const a = e.attachment, count = a.uvs ? a.uvs.length / 2 : a.vertexCount;
    if (!a.vertices || count === undefined || a.vertices.length === count * 2) continue;
    out.set(`${k.name}|${ss.slot}|${e.key}`, decodeBinds(a.vertices).map((b) => b.map((x) => doc.bones?.[x.bone]?.name ?? `#${x.bone}`).join(",")).join(";"));
  }
  return out;
}

/** An attachment the step did not aim at, bound to other bones after it than before (renames followed). */
function drift(before: Skeleton, after: Skeleton, op: Op): string | null {
  const was = boundBones(before), now = boundBones(after), target = op.target && `${op.target.skin}|${op.target.slot}|${op.target.key}`;
  const rename = (names: string) => (op.renames ? names.split(/([,;])/).map((n) => (n === op.renames![0] ? op.renames![1] : n)).join("") : names);
  for (const [key, names] of now) {
    if (key === target || !was.has(key)) continue;
    if (rename(was.get(key)!) !== names) return `"${key}" is bound to other bones after the step`;
  }
  return null;
}

/** Poses with a bone not finite, over the run (reported, not failed: F6). */
let degenerate = 0;

/** What a document must hold after any step. */
function invariants(doc: Skeleton, images: AtlasImages, startIssues: ReadonlySet<string>, rnd: () => number): string | null {
  const fresh = profileIssues(doc).map((i) => `${i.where}: ${i.message}`).filter((i) => !startIssues.has(i));
  if (fresh.length) return `new profile issues: ${fresh.slice(0, 3).join(" | ")}`;
  const written = writeSkeleton(doc);
  const back = readSkeleton(written);
  if (back.issues.length) return `reading what was written says: ${back.issues.slice(0, 3).map((i) => `${i.where}: ${i.message}`).join(" | ")}`;
  if (writeSkeleton(back.skeleton) !== written) return "write → read → write is not a fixed point";
  const anims = doc.animations ?? [];
  const anim = anims.length ? anims[Math.floor(rnd() * anims.length)]!.name : null;
  // Posing must not throw. A degenerate rig (a path constraint with nothing to follow, keys driven
  // through a slider to extremes) may pose bones to NaN: BoneBurst's C# runtime poses the same
  // bones to NaN on the same files (E7-PLAN step 4, F6), so that is counted, not failed.
  const poser = new Poser(doc, images);
  for (const [a, t] of [[null, 0], [anim, rnd() * 2]] as const) {
    const p = poser.pose(null, a, t);
    for (let i = 0; i < (doc.bones ?? []).length; i++) if (p.rig.active[i] && ![...p.rig.matrix(i)].every(Number.isFinite)) { degenerate++; break; }
  }
  return null;
}

const STEPS = Number(process.env.FUZZ_STEPS ?? 60);
const SEEDS = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : [1, 2];
const RIGS = corpus().filter((r) => !process.env.FUZZ_RIG || r.name.includes(process.env.FUZZ_RIG));

/** Per edit kind: applied, refused, or no change (FUZZ_STATS=1 prints it). */
const stats = new Map<string, { applied: number; refused: number; same: number }>();

describe("edits fuzzed (E7 step 4)", () => {
  afterAll(() => {
    if (!process.env.FUZZ_STATS) return;
    for (const [k, t] of [...stats].sort()) console.log(`${k.padEnd(18)} applied ${String(t.applied).padStart(6)}  refused ${String(t.refused).padStart(6)}  unchanged ${String(t.same).padStart(5)}`);
    console.log(`poses with a bone not finite (degenerate rigs, as the runtime): ${degenerate}`);
  });
  it("has the corpus", () => expect(RIGS.length).toBeGreaterThanOrEqual(process.env.FUZZ_RIG ? 1 : 17));
  for (const rig of RIGS) {
    for (const seed of SEEDS) {
      it(`${rig.name}, seed ${seed}: ${STEPS} steps hold the invariants; undo and redo give back the very documents`, () => {
        const start = readSkeleton(readFileSync(rig.json, "utf8")).skeleton;
        const images = atlasImages(readAtlas(readFileSync(rig.atlas, "utf8")));
        const rnd = prng(seed * 7919 + rig.name.length), next = generator(rnd, images);
        const startIssues = new Set(profileIssues(start).map((i) => `${i.where}: ${i.message}`));
        const h = new History(start, STEPS + 10);
        const trail: string[] = [];
        for (let step = 0; step < STEPS; step++) {
          const op = next(h.doc);
          if (!op) continue;
          const where = `${rig.name} seed ${seed} step ${step}: ${op.label}`;
          const prevDoc = h.doc;
          const kind = op.label.split(" ")[0]!, tally = stats.get(kind) ?? { applied: 0, refused: 0, same: 0 };
          stats.set(kind, tally);
          try {
            if (h.apply(op.label, op.edit)) { trail.push(op.label); tally.applied++; } else tally.same++;
          } catch (err) {
            if (err instanceof EditRefused) { tally.refused++; continue; }
            throw new Error(`${where} threw ${err instanceof Error ? err.stack : String(err)}\nsteps so far: ${trail.join(" ; ")}`);
          }
          let broken: string | null;
          try { broken = drift(prevDoc, h.doc, op) ?? invariants(h.doc, images, startIssues, rnd); } catch (err) { broken = `checking threw ${err instanceof Error ? err.message : String(err)}`; }
          if (broken) {
            // FUZZ_DUMP=<folder>: the documents before and after the step, to look at.
            if (process.env.FUZZ_DUMP) {
              writeFileSync(join(process.env.FUZZ_DUMP, "before.json"), writeSkeleton(h.entries.done > 1 ? (h.undo(), h.doc) : start));
              h.redo();
              writeFileSync(join(process.env.FUZZ_DUMP, "after.json"), writeSkeleton(h.doc));
            }
            throw new Error(`${where}: ${broken}\nsteps so far: ${trail.join(" ; ")}`);
          }
        }
        const last = h.doc, done = h.entries.done;
        h.goTo(0);
        expect(h.doc, `${rig.name} seed ${seed}: undo all`).toBe(start);
        h.goTo(done);
        expect(h.doc, `${rig.name} seed ${seed}: redo all`).toBe(last);
      }, Math.max(5000, STEPS * 100));
    }
  }
});
