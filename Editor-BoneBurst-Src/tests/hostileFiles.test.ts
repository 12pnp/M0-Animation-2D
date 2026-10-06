import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { missingRegions } from "@/engine/atlasCheck";
import { drawnVertices } from "@/engine/draw";
import { atlasImages } from "@/engine/regions";
import { readAtlas } from "@/io/atlas";
import { readPsdLayers } from "@/io/psd";
import { readSidecar } from "@/io/sidecar";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import type { Issue } from "@/model/issue";
import { profileIssues } from "@/model/profile";
import { Poser } from "@/ui/stage/posed";
import { SAMPLES } from "./fixtures/samples";

/**
 * Hostile files (E7-PLAN step 5): what the open path does with files a person, a tool or a broken
 * disk hands it. Each either opens (then it poses, draws, saves, saves to a fixed point, and a
 * damaged one says so) or is refused with the editor's own reason; never a TypeError, RangeError
 * or stack overflow, and never longer than 2 s. HOSTILE_SEED / HOSTILE_STEPS for longer runs.
 */

/** What reached the user: opened (with what it said), or refused (with the reason). */
type Outcome = { opened: true; issues: Issue[] } | { opened: false; reason: string };

/** The editor's own refusals; anything else thrown is a bug. */
const BUGS = [TypeError, RangeError, ReferenceError, EvalError, URIError];

/** `Session.open`'s path without the DOM, plus what the stage and Save then do with the document. */
function open(skeleton: string | null, atlas: string | null, sidecar: string | null = null): Outcome {
  // Reading: the only stage that may refuse, with the editor's own reason.
  let doc, issues: Issue[], images;
  try {
    ({ skeleton: doc, issues } = skeleton !== null ? readSkeleton(skeleton) : { skeleton: readSkeleton('{"skeleton":{"spine":"4.3.0"},"bones":[{"name":"root"}]}').skeleton, issues: [] as Issue[] });
    issues = [...issues, ...profileIssues(doc)];
    const parsed = atlas !== null ? readAtlas(atlas) : null;
    if (sidecar !== null) issues.push(...readSidecar(sidecar).issues);
    images = atlasImages(parsed ?? { pages: [] } as never);
    if (parsed) issues.push(...missingRegions(doc, images));
    // As the app: opening poses the new document before it takes the tab (app.ts open, stage.opened),
    // so a file the engine cannot pose is refused with the engine's reason, the open tab kept.
    new Poser(doc, images).pose(null, null, 0);
  } catch (err) {
    if (BUGS.some((B) => err instanceof B) || !(err instanceof Error)) throw err;
    return { opened: false, reason: err.message };
  }
  // Opened: from here nothing may throw. The stage: every skin's setup pose, every animation at a
  // few times, and what it draws.
  const poser = new Poser(doc, images);
  const skins = [null, ...(doc.skins ?? []).map((k) => k.name).filter((n) => n !== "default")];
  for (const skin of skins) {
    for (const [anim, t] of [[null, 0], ...(doc.animations ?? []).flatMap((a) => [[a.name, 0], [a.name, 0.37], [a.name, 5]] as const)] as const) {
      const p = poser.pose(skin, anim, t);
      for (const d of p.draw.slots) {
        const pos = new Float64Array(d.vertexCount * 2);
        drawnVertices(p.rig, d, pos);
        const bad = d.triangles.find((i) => i >= d.vertexCount);
        if (bad !== undefined) throw new Error(`slot ${d.slot} draws a triangle with vertex ${bad} of ${d.vertexCount}`);
      }
    }
  }
  // Save: it writes, and what it writes reads back to itself.
  const written = writeSkeleton(doc);
  if (writeSkeleton(readSkeleton(written).skeleton) !== written) throw new Error("save → read → save is not a fixed point");
  return { opened: true, issues };
}

/** Run `open` under the clock; a hang or a slow file fails. */
function timed(label: string, f: () => Outcome): Outcome {
  // HOSTILE_LOG=<file>: each case named before it runs, so a hang shows which one.
  if (process.env.HOSTILE_LOG) appendFileSync(process.env.HOSTILE_LOG, `${label}\n`);
  const t0 = performance.now();
  let out: Outcome;
  try { out = f(); } catch (err) { throw new Error(`${label}: ${err instanceof Error ? `${err.name}: ${err.message}\n${err.stack?.split("\n").slice(1, 5).join("\n")}` : String(err)}`); }
  const ms = performance.now() - t0;
  if (ms > 2000) throw new Error(`${label}: took ${Math.round(ms)} ms`);
  if (!out.opened && !out.reason.trim()) throw new Error(`${label}: refused without a reason`);
  return out;
}

const STICK = join(__dirname, "fixtures", "stickman");
const stickJson = readFileSync(join(STICK, "Stickman_IK.json"), "utf8"), stickAtlas = readFileSync(join(STICK, "Stickman_IK.atlas.txt"), "utf8");
/** The stickman with `f` applied to its parsed JSON. */
const stick = (f: (j: any) => void): string => { const j = JSON.parse(stickJson); f(j); return JSON.stringify(j); };
const mesh = (extra: object) => ({ type: "mesh", uvs: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2], hull: 3, width: 10, height: 10, vertices: [0, 0, 5, 0, 5, 5], ...extra });
const firstSlot = (j: any) => j.slots[0].name;
const skinAdd = (j: any, slot: string, name: string, a: object) => { const sk = j.skins[0]; sk.attachments ??= {}; sk.attachments[slot] ??= {}; sk.attachments[slot][name] = a; };

/** Hand-made cases: what, and its skeleton and atlas texts. */
/** Built when its case runs: a few are megabytes. */
const TABLE: [string, () => [string | null, string | null]][] = [
  ["an empty file", () => ["", stickAtlas]],
  ["whitespace", () => ["  \n ", stickAtlas]],
  ["null", () => ["null", stickAtlas]],
  ["an array", () => ["[]", stickAtlas]],
  ["a cut-off file", () => [stickJson.slice(0, Math.floor(stickJson.length / 2)), stickAtlas]],
  ["a byte-order mark", () => [`﻿${stickJson}`, stickAtlas]],
  ["1e400", () => [stickJson.replace(/"length":\s*([\d.]+)/, '"length":1e400'), stickAtlas]],
  ["nesting 100,000 deep", () => [`${"[".repeat(100000)}${"]".repeat(100000)}`, stickAtlas]],
  ["a lone surrogate", () => [stickJson.replace('"root"', '"\\ud800"'), stickAtlas]],
  ["bones not an array", () => [stick((j) => { j.bones = { a: 1 }; }), stickAtlas]],
  ["no bones", () => [stick((j) => { delete j.bones; }), stickAtlas]],
  ["a bone without a name", () => [stick((j) => { delete j.bones[1].name; }), stickAtlas]],
  ["two bones of one name", () => [stick((j) => { j.bones[2].name = j.bones[1].name; }), stickAtlas]],
  ["a bone whose parent is missing", () => [stick((j) => { j.bones[2].parent = "nobody"; }), stickAtlas]],
  ["a bone its own parent", () => [stick((j) => { j.bones[2].parent = j.bones[2].name; }), stickAtlas]],
  ["a bone whose parent comes after it", () => [stick((j) => { j.bones[1].parent = j.bones[3].name; }), stickAtlas]],
  ["two roots", () => [stick((j) => { delete j.bones[2].parent; }), stickAtlas]],
  ["a bone named with numbers", () => [stick((j) => { j.bones[1].name = 5; }), stickAtlas]],
  ["a slot on a missing bone", () => [stick((j) => { j.slots[0].bone = "nobody"; }), stickAtlas]],
  ["a slot showing a missing attachment", () => [stick((j) => { j.slots[0].attachment = "nothing"; }), stickAtlas]],
  ["skin attachments for a missing slot", () => [stick((j) => { skinAdd(j, "noslot", "a", { width: 1, height: 1 }); }), stickAtlas]],
  ["a mesh with odd uvs", () => [stick((j) => { skinAdd(j, firstSlot(j), "m", mesh({ uvs: [0, 0, 1] })); j.slots[0].attachment = "m"; }), stickAtlas]],
  ["a mesh triangle out of range", () => [stick((j) => { skinAdd(j, firstSlot(j), "m", mesh({ triangles: [0, 1, 9] })); j.slots[0].attachment = "m"; }), stickAtlas]],
  ["a mesh with no triangles", () => [stick((j) => { skinAdd(j, firstSlot(j), "m", mesh({ triangles: [] })); j.slots[0].attachment = "m"; }), stickAtlas]],
  ["a mesh hull past its vertices", () => [stick((j) => { skinAdd(j, firstSlot(j), "m", mesh({ hull: 40 })); j.slots[0].attachment = "m"; }), stickAtlas]],
  ["a weighted mesh bound to bone 999", () => [stick((j) => { skinAdd(j, firstSlot(j), "m", mesh({ vertices: [1, 999, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1] })); j.slots[0].attachment = "m"; }), stickAtlas]],
  ["a weighted mesh cut short", () => [stick((j) => { skinAdd(j, firstSlot(j), "m", mesh({ vertices: [1, 0, 0, 0, 1, 2, 0] })); j.slots[0].attachment = "m"; }), stickAtlas]],
  ["a weighted mesh with 1e6 bones on a vertex", () => [stick((j) => { skinAdd(j, firstSlot(j), "m", mesh({ vertices: [1e6, 0, 0, 0, 1] })); j.slots[0].attachment = "m"; }), stickAtlas]],
  ["a linked mesh whose parent is missing", () => [stick((j) => { skinAdd(j, firstSlot(j), "l", { type: "linkedmesh", parent: "none", width: 1, height: 1 }); j.slots[0].attachment = "l"; }), stickAtlas]],
  ["linked meshes in a cycle", () => [stick((j) => { skinAdd(j, firstSlot(j), "l1", { type: "linkedmesh", parent: "l2" }); skinAdd(j, firstSlot(j), "l2", { type: "linkedmesh", parent: "l1" }); j.slots[0].attachment = "l1"; }), stickAtlas]],
  ["a sequence of 0", () => [stick((j) => { skinAdd(j, firstSlot(j), "q", { width: 1, height: 1, sequence: { count: 0 } }); j.slots[0].attachment = "q"; }), stickAtlas]],
  ["a sequence of a million", () => [stick((j) => { skinAdd(j, firstSlot(j), "q", { width: 1, height: 1, sequence: { count: 1e6, digits: 3 } }); j.slots[0].attachment = "q"; }), stickAtlas]],
  ["a path with 3 vertices and no lengths", () => [stick((j) => { skinAdd(j, firstSlot(j), "p", { type: "path", vertexCount: 1, vertices: [0, 0] }); j.slots[0].attachment = "p"; }), stickAtlas]],
  ["a clipping end slot missing", () => [stick((j) => { skinAdd(j, firstSlot(j), "c", { type: "clipping", end: "none", vertexCount: 3, vertices: [0, 0, 1, 0, 1, 1] }); j.slots[0].attachment = "c"; }), stickAtlas]],
  ["an IK on its own target", () => [stick((j) => { j.constraints = [{ type: "ik", name: "k", bones: [j.bones[2].name], target: j.bones[2].name }]; }), stickAtlas]],
  ["an IK naming missing bones", () => [stick((j) => { j.constraints = [{ type: "ik", name: "k", bones: ["x", "y", "z"], target: "w" }]; }), stickAtlas]],
  ["an IK with three bones", () => [stick((j) => { j.constraints = [{ type: "ik", name: "k", bones: [j.bones[1].name, j.bones[2].name, j.bones[3].name], target: j.bones[0].name }]; }), stickAtlas]],
  ["a transform constraint from itself", () => [stick((j) => { j.constraints = [{ type: "transform", name: "t", bones: [j.bones[1].name], source: j.bones[1].name, mixRotate: 1 }]; }), stickAtlas]],
  ["a path constraint on a missing slot", () => [stick((j) => { j.constraints = [{ type: "path", name: "p", bones: [j.bones[1].name], slot: "none" }]; }), stickAtlas]],
  ["physics with a zero step", () => [stick((j) => { j.constraints = [{ type: "physics", name: "f", bone: j.bones[1].name, step: 0, rotate: 1 }]; }), stickAtlas]],
  ["a slider on a missing animation", () => [stick((j) => { j.constraints = [{ type: "slider", name: "s", animation: "none", mix: 1 }]; }), stickAtlas]],
  ["a slider on its own animation's loop", () => [stick((j) => { const a = Object.keys(j.animations)[0]; j.constraints = [{ type: "slider", name: "s", animation: a, bone: j.bones[1].name, property: "rotate", scale: 1e9 }]; }), stickAtlas]],
  ["keys out of order and before 0", () => [stick((j) => { const a: any = Object.values(j.animations)[0]; const g: any = Object.values(a.bones)[0]; const tl = Object.values(g)[0] as any[]; tl.reverse(); tl.push({ time: -3, value: 1 }); }), stickAtlas]],
  ["a key at 1e30", () => [stick((j) => { const a: any = Object.values(j.animations)[0]; const g: any = Object.values(a.bones)[0]; (Object.values(g)[0] as any[]).push({ time: 1e30, value: 1 }); }), stickAtlas]],
  ["a curve of the wrong length", () => [stick((j) => { const a: any = Object.values(j.animations)[0]; const g: any = Object.values(a.bones)[0]; (Object.values(g)[0] as any[])[0].curve = [0.5]; }), stickAtlas]],
  ["timelines for missing bones and slots", () => [stick((j) => { const a: any = Object.values(j.animations)[0]; a.bones.nobody = { rotate: [{ value: 1 }] }; a.slots = { noslot: { rgba: [{ color: "ff00ffff" }] } }; }), stickAtlas]],
  ["a draw-order offset out of range", () => [stick((j) => { const a: any = Object.values(j.animations)[0]; a.drawOrder = [{ offsets: [{ slot: firstSlot(j), offset: 9999 }] }]; }), stickAtlas]],
  ["a draw order moving one slot twice", () => [stick((j) => { const a: any = Object.values(j.animations)[0]; a.drawOrder = [{ offsets: [{ slot: firstSlot(j), offset: 1 }, { slot: firstSlot(j), offset: 2 }] }]; }), stickAtlas]],
  ["an event key for a missing event", () => [stick((j) => { const a: any = Object.values(j.animations)[0]; a.events = [{ name: "none" }]; }), stickAtlas]],
  ["a deform for a missing attachment", () => [stick((j) => { const a: any = Object.values(j.animations)[0]; a.attachments = { default: { [firstSlot(j)]: { none: { deform: [{ vertices: [1, 2] }] } } } }; }), stickAtlas]],
  ["a colour that is not one", () => [stick((j) => { j.slots[0].color = "zzzzzzzz"; j.bones[1].color = "12"; }), stickAtlas]],
  ["Spine 3.8", () => [stick((j) => { j.skeleton.spine = "3.8.99"; }), stickAtlas]],
  ["100,000 bones", () => [stick((j) => { for (let i = 0; i < 100000; i++) j.bones.push({ name: `b${i}`, parent: i ? `b${i - 1}` : j.bones[0].name }); }), stickAtlas]],
  ["no atlas", () => [stickJson, null]],
  ["an empty atlas", () => [stickJson, ""]],
  ["an atlas that is not one", () => [stickJson, "\u0000\u0001garbage\n\n:::"]],
  ["an atlas region with negative size", () => [stickJson, stickAtlas.replace(/bounds:\s*(\d+),(\d+),(\d+),(\d+)/, "bounds: $1,$2,-50,-50")]],
  ["an atlas region past its page", () => [stickJson, stickAtlas.replace(/bounds:\s*(\d+),(\d+),(\d+),(\d+)/, "bounds: 99999,99999,$3,$4")]],
  ["an atlas without page size", () => [stickJson, stickAtlas.replace(/size:[^\n]*\n/, "")]],
  ["an atlas page with no regions", () => [stickJson, `${stickAtlas}\n\nlonely.png\nsize: 1,1\n`]],
];

/**
 * The cases BoneBurst's C# reader refuses (`run.sh --dump` on each, 2026-10-06; the 100,000-deep
 * nesting overflowed its stack): opened here, each must say what is wrong, or Unity is where the
 * user finds out. The others the C# reader reads, and may open quietly.
 */
const CSHARP_REFUSES = new Set([
  "an empty file",
  "whitespace",
  "null",
  "an array",
  "a cut-off file",
  "nesting 100,000 deep",
  "a lone surrogate",
  "bones not an array",
  "no bones",
  "a bone without a name",
  "two bones of one name",
  "a bone whose parent is missing",
  "a bone its own parent",
  "a bone whose parent comes after it",
  "a bone named with numbers",
  "a slot on a missing bone",
  "skin attachments for a missing slot",
  "a mesh with odd uvs",
  "a mesh triangle out of range",
  "a mesh with no triangles",
  "a mesh hull past its vertices",
  "a weighted mesh bound to bone 999",
  "a weighted mesh cut short",
  "a weighted mesh with 1e6 bones on a vertex",
  "a linked mesh whose parent is missing",
  "linked meshes in a cycle",
  "a sequence of a million",
  "a path with 3 vertices and no lengths",
  "a clipping end slot missing",
  "an IK naming missing bones",
  "a path constraint on a missing slot",
  "a slider on a missing animation",
  "a curve of the wrong length",
  "timelines for missing bones and slots",
  "a draw-order offset out of range",
  "a draw order moving one slot twice",
  "an event key for a missing event",
  "a deform for a missing attachment",
  "a colour that is not one",
  "Spine 3.8",
  "an empty atlas",
  "an atlas that is not one",
]);

describe("hostile files: the hand-made cases (E7 step 5)", () => {
  it.each(TABLE)("%s: opens and works, or is refused with a reason", (what, files) => {
    const [json, atlas] = files();
    // HOSTILE_EXPORT=<folder>: each case's files, to give BoneBurst's C# reader (run.sh --dump).
    if (process.env.HOSTILE_EXPORT && json !== null) {
      const base = join(process.env.HOSTILE_EXPORT, what.replace(/[^a-z0-9]+/gi, "_"));
      writeFileSync(`${base}.json`, json);
      writeFileSync(`${base}.atlas`, atlas ?? "");
    }
    const out = timed(what, () => open(json, atlas));
    // A file the C# reader refuses, opened here, says so.
    if (out.opened && CSHARP_REFUSES.has(what)) expect(out.issues.length, `${what}: opened, saying nothing; Unity refuses it`).toBeGreaterThan(0);
  });
  it.each([
    ["sidecar: not JSON", "{{"],
    ["sidecar: wrong types", JSON.stringify({ view: 5, guides: "x", references: [{ path: 3 }], notes: {} })],
    ["sidecar: a guide at NaN", '{"guides":[{"axis":"x","at":1e400}]}'],
  ])("%s", (what, sidecar) => { timed(what, () => open(stickJson, stickAtlas, sidecar)); });
  it.each([
    ["not a PSD", new Uint8Array([1, 2, 3, 4, 5])],
    ["empty", new Uint8Array()],
    ["a PSD signature then nothing", new TextEncoder().encode("8BPS\u0000\u0001")],
  ])("PSD, %s: refused with a reason", (_, bytes) => {
    expect(() => readPsdLayers(bytes, "x.psd")).toThrow(/x\.psd/);
  });
});

// ---- Mutations of every corpus file ----

/** mulberry32. */
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

const BIG = "__HOSTILE_BIG__";
/** One random mutation of a parsed JSON value, in place; what it did. */
function mutate(root: any, rnd: () => number): string {
  const nodes: [any, string | number, string][] = [];
  const walk = (v: any, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => { nodes.push([v, i, `${path}[${i}]`]); walk(x, `${path}[${i}]`); });
    else if (v && typeof v === "object") for (const k of Object.keys(v)) { nodes.push([v, k, `${path}.${k}`]); walk(v[k], `${path}.${k}`); }
  };
  walk(root, "");
  if (!nodes.length) return "nothing to mutate";
  const [parent, key, path] = nodes[Math.floor(rnd() * nodes.length)]!;
  const values = [null, 0, -1, 1e9, -1e9, 0.5, "", "x", [], {}, true, BIG, -0];
  switch (Math.floor(rnd() * 6)) {
    case 0: if (Array.isArray(parent)) parent.splice(key as number, 1); else delete parent[key]; return `drop ${path}`;
    case 1: { const v = values[Math.floor(rnd() * values.length)]; parent[key] = v; return `${path} = ${JSON.stringify(v)}`; }
    case 2: if (Array.isArray(parent)) { parent.splice(key as number, 0, structuredClone(parent[key as number])); return `duplicate ${path}`; } return mutate(root, rnd);
    case 3: if (Array.isArray(parent[key])) { parent[key].reverse(); return `reverse ${path}`; } return mutate(root, rnd);
    case 4: if (Array.isArray(parent[key])) { parent[key].length = Math.floor(parent[key].length / 2); return `cut ${path}`; } return mutate(root, rnd);
    default: if (typeof parent[key] === "string" && nodes.length > 1) {
      const other = nodes.map(([p, k]) => (p as Record<string | number, unknown>)[k]).filter((x) => typeof x === "string");
      parent[key] = other[Math.floor(rnd() * other.length)];
      return `${path} = another name`;
    } return mutate(root, rnd);
  }
}
const toText = (j: unknown) => JSON.stringify(j).replaceAll(`"${BIG}"`, "1e400");

/** One random mutation of an atlas's text: a line dropped, doubled, or a number in it changed. */
function mutateAtlas(text: string, rnd: () => number): [string, string] {
  const lines = text.split("\n"), i = Math.floor(rnd() * lines.length);
  switch (Math.floor(rnd() * 3)) {
    case 0: lines.splice(i, 1); return [lines.join("\n"), `drop line ${i}`];
    case 1: lines.splice(i, 0, lines[i]!); return [lines.join("\n"), `double line ${i}`];
    default: {
      const v = ["-5", "0", "99999", "x", "1e400", ""][Math.floor(rnd() * 6)]!;
      lines[i] = lines[i]!.replace(/-?\d+/, v);
      return [lines.join("\n"), `line ${i} number → ${JSON.stringify(v)}`];
    }
  }
}

interface Rig { readonly name: string; readonly json: string; readonly atlas: string; readonly sidecar: string | null }
function corpus(): Rig[] {
  const out: Rig[] = [{ name: "stickman", json: stickJson, atlas: stickAtlas, sidecar: null }];
  if (!existsSync(SAMPLES)) throw new Error(`samples not found at ${SAMPLES}`);
  for (const d of readdirSync(SAMPLES, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const files = readdirSync(join(SAMPLES, d.name)), atlas = files.find((f) => /\.atlas(\.txt)?$/.test(f));
    if (!atlas) continue;
    for (const j of files.filter((f) => f.endsWith(".json") && !f.endsWith(".bb.json"))) {
      out.push({ name: `${d.name}/${j}`, json: readFileSync(join(SAMPLES, d.name, j), "utf8"), atlas: readFileSync(join(SAMPLES, d.name, atlas), "utf8"), sidecar: null });
    }
  }
  return out;
}

const STEPS = Number(process.env.HOSTILE_STEPS ?? 12);
const SEEDS = process.env.HOSTILE_SEED ? [Number(process.env.HOSTILE_SEED)] : [1];

describe("hostile files: mutations of every corpus file (E7 step 5)", () => {
  const rigs = corpus();
  it("has the corpus", () => expect(rigs.length).toBeGreaterThanOrEqual(17));
  for (const rig of rigs) {
    for (const seed of SEEDS) {
      it(`${rig.name}, seed ${seed}: ${STEPS} mutated skeletons and atlases each open and work, or are refused with a reason`, () => {
        const rnd = prng(seed * 104729 + rig.name.length * 31);
        const base = JSON.parse(rig.json);
        for (let n = 0; n < STEPS; n++) {
          // A skeleton with 1–3 mutations, its atlas as it was; then the atlas mutated, the skeleton as it was.
          const j = structuredClone(base), did: string[] = [];
          for (let k = 0, m = 1 + Math.floor(rnd() * 3); k < m; k++) did.push(mutate(j, rnd));
          timed(`${rig.name} seed ${seed} #${n} skeleton: ${did.join("; ")}`, () => open(toText(j), rig.atlas));
          const [atlas, how] = mutateAtlas(rig.atlas, rnd);
          timed(`${rig.name} seed ${seed} #${n} atlas: ${how}`, () => open(rig.json, atlas));
        }
      }, Math.max(10_000, STEPS * 2000));
    }
  }
});
