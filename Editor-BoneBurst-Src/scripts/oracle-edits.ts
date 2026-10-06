/**
 * E6's edit-script parity (docs/E6-PLAN.md step 2): the same edits made in the old editor and in
 * v2 through their AI bridges (the tools both contracts share), each result written out, and the
 * two posed frame by frame. Not part of `npm run check`: it needs the old editor's folder.
 *
 * Run: npx vite-node scripts/oracle-edits.ts [filter]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { NO_IMAGES } from "../src/engine/regions";
import { readSkeleton } from "../src/io/skeletonRead";
import { boneNumber } from "../src/model/defaults";
import type { Skeleton } from "../src/model/skeleton";
import { keyLists, keyTime, pathId, type TimelinePath } from "../src/model/timelines";
import { EditRefused } from "../src/edit/history";
import { setCurve } from "../src/edit/keys";
import { Bridge, NewEditor, OldEditor, poseGap, ROOT, serve, V1, V1_BRIDGE_PORT, V1_URL, V2_URL } from "./oracle/editors";

const OUT = join(ROOT, "node_modules", ".cache", "oracle-edits");
const FIGURE = join(ROOT, "tests", "fixtures", "psd", "figure.psd");
const STICK = join(ROOT, "tests", "fixtures", "stickman");
const STICK_FILES = ["Stickman_IK.json", "Stickman_IK.atlas.txt", "Stickman_IK_tex.png"].map((f) => join(STICK, f));

type Call = readonly [string, Record<string, unknown>];
type Point = readonly [number, number];

interface Script {
  readonly name: string;
  /** How each editor opens the rig. */
  readonly openOld: (e: OldEditor) => Promise<void>;
  readonly openNew: (e: NewEditor) => Promise<void>;
  /** The calls, in v2's coordinates; `shift` moves a point to the old editor's. */
  readonly calls: (shift: (p: Point) => Point) => Call[];
  /** Where the old editor's origin is in v2's coordinates' terms (v1 point = v2 point + offset). */
  readonly offset: Point;
  readonly animation: string;
  /** Agreement: a retarget sampled frame by frame, or keys given exactly. */
  readonly tolerance: number;
  /**
   * A known difference: what it is, and v2's result changed to the old editor's way. Within the
   * tolerance after the change, the difference is shown to be the whole gap.
   */
  readonly known?: { readonly why: string; readonly adjust: (v2: Skeleton, v1: Skeleton) => Skeleton };
}

/** The keys of `anim` the old editor wrote as holds that were not holds in the source (keys the script added left out: they are compared). */
function madeHolds(v1: Skeleton, anim: string, source: Skeleton): { path: TimelinePath; time: number }[] {
  const a = v1.animations!.find((x) => x.name === anim)!, src = source.animations!.find((x) => x.name === anim)!;
  const was = new Map(keyLists(src).map(({ path, keys }) => [pathId(path), keys]));
  const out: { path: TimelinePath; time: number }[] = [];
  for (const { path, keys } of keyLists(a)) {
    for (const k of keys) {
      const before = was.get(pathId(path))?.find((x) => Math.abs(keyTime(x) - keyTime(k)) < 1e-4);
      if (k.curve === "stepped" && before && before.curve !== "stepped") out.push({ path, time: keyTime(k) });
    }
  }
  return out;
}

const JOINTS: Record<string, Point> = {
  pelvis: [0, 134], neck: [0, 279], head: [0, 378], "hip.left": [-20, 129], "knee.left": [-20, 76], "ankle.left": [-20, 28],
  "hip.right": [20, 129], "knee.right": [20, 76], "ankle.right": [20, 28], "shoulder.left": [-70, 263], "elbow.left": [-70, 211], "wrist.left": [-70, 158],
  "shoulder.right": [70, 263], "elbow.right": [70, 211], "wrist.right": [70, 158],
};

/** The stickman's walk: hips bob, chest sway, arms swing, feet (IK targets) stride; eased. */
function walk(): Call[] {
  const doc = readSkeleton(readFileSync(STICK_FILES[0]!, "utf8")).skeleton;
  const bone = (n: string) => doc.bones!.find((b) => b.name === n)!;
  const at = (n: string) => ({ x: boneNumber(bone(n), "x"), y: boneNumber(bone(n), "y"), r: boneNumber(bone(n), "rotation") });
  const hips = at("hips"), chest = at("chest"), near = at("arm_near_up"), far = at("arm_far_up"), fn = at("foot_near_target"), ff = at("foot_far_target");
  const keys: Record<string, unknown>[] = [];
  for (const f of [0, 6, 12, 18, 24]) keys.push({ bone: "hips", frame: f, y: hips.y - (f % 12 ? 0 : 6), ease: "inout" });
  for (const [f, s] of [[0, 1], [12, -1], [24, 1]] as const) {
    keys.push({ bone: "chest", frame: f, rotation: chest.r + 4 * s, ease: "inout" });
    keys.push({ bone: "arm_near_up", frame: f, rotation: near.r + 25 * s, ease: "inout" }, { bone: "arm_far_up", frame: f, rotation: far.r - 25 * s, ease: "inout" });
    keys.push({ bone: "foot_near_target", frame: f, x: fn.x + 40 * s, y: fn.y, ease: "inout" }, { bone: "foot_far_target", frame: f, x: ff.x - 40 * s, y: ff.y, ease: "inout" });
  }
  // Into the rig's own `run` (the old editor has no new_animation, and keys only an animation that exists).
  return [["set_keys", { animation: "run", keys }]];
}

const SCRIPTS: Script[] = [
  {
    name: "figure: auto_rig → apply_motion idle_front",
    // v2 makes a PSD rig at 30 fps; the old editor at 24: set on the empty document (a rate change re-times keys).
    openOld: async (e) => { await e.setFps(30); await e.importPsd(FIGURE); },
    openNew: (e) => e.open([FIGURE]),
    calls: (shift) => [
      ["auto_rig", { view: "front", joints: Object.fromEntries(Object.entries(JOINTS).map(([k, p]) => [k, shift(p)])) }],
      ["apply_motion", { motion: "idle_front", animation: "idle" }],
    ],
    offset: [150, -400], animation: "idle", tolerance: 0.5,
    known: {
      why: "The knees bend the other way: for legs drawn straight, the old editor writes bendPositive false; v2 bends them forward for the facing (E5 step 5).",
      adjust: (d) => ({ ...d, constraints: d.constraints!.map((c) => (c.type === "ik" ? { ...c, bendPositive: false } : c)) }),
    },
  },
  {
    name: "stickman: a walk keyed with set_keys",
    // The file says 24 fps; both editors keep it.
    openOld: (e) => e.openSpine(STICK_FILES),
    openNew: (e) => e.open(STICK_FILES),
    calls: () => walk(),
    offset: [0, 0], animation: "run", tolerance: 0.01,
    known: {
      why: "The old editor turns the rig's own keys between equal values into holds; keyed between, they stay holds. In Spine's format those intervals are linear, as v2 keeps them.",
      adjust: (d, v1) => {
        const source = readSkeleton(readFileSync(STICK_FILES[0]!, "utf8")).skeleton;
        // A hold on a timeline's last key changes nothing (and the edit refuses it).
        return madeHolds(v1, "run", source).reduce((doc, r) => { try { return setCurve("run", [r], "stepped")(doc); } catch (e) { if (e instanceof EditRefused) return doc; throw e; } }, d);
      },
    },
  },
];

async function main(): Promise<void> {
  const filter = process.argv[2];
  mkdirSync(OUT, { recursive: true });
  const servers = [await serve(V1_URL, V1), await serve(V2_URL, ROOT)];
  const v2Port = 58000 + Math.floor(Math.random() * 1000);
  const oldBridge = await Bridge.start(join(V1, "mcp", "boneburst-bridge.mjs"), V1_BRIDGE_PORT);
  const newBridge = await Bridge.start(join(ROOT, "mcp", "bridge.mjs"), v2Port);
  const browser = await chromium.launch();
  const report: Record<string, unknown>[] = [];
  try {
    for (const s of SCRIPTS.filter((x) => !filter || x.name.includes(filter))) {
      const row: Record<string, unknown> = { script: s.name };
      try {
        const shift = (p: Point): Point => [p[0] + s.offset[0], p[1] + s.offset[1]];
        const two = await NewEditor.open(browser, v2Port);
        await s.openNew(two);
        await two.connect();
        const newAnswers = [];
        for (const [name, args] of s.calls((p) => p)) newAnswers.push(await newBridge.tool(name, args));
        const v2 = await two.save();
        await two.close();
        const old = await OldEditor.open(browser);
        await s.openOld(old);
        await old.connect();
        const oldAnswers = [];
        for (const [name, args] of s.calls(shift)) oldAnswers.push(await oldBridge.tool(name, args));
        const v1 = await old.exportSkeleton();
        await old.close();
        const tag = s.name.split(":")[0]!;
        writeFileSync(join(OUT, `${tag}.v1.json`), v1);
        writeFileSync(join(OUT, `${tag}.v2.json`), v2);
        const a = readSkeleton(v2).skeleton, b = readSkeleton(v1).skeleton;
        // Each editor's root sits at its own origin: with the origins apart, it is not compared.
        const gap = poseGap(a, b, NO_IMAGES, { animations: [s.animation], offset: s.offset, ...(s.offset[0] || s.offset[1] ? { skip: ["root"] } : {}) });
        const explained = s.known ? poseGap(s.known.adjust(a, b), b, NO_IMAGES, { animations: [s.animation], offset: s.offset, ...(s.offset[0] || s.offset[1] ? { skip: ["root"] } : {}) }) : null;
        Object.assign(row, {
          pose: { distance: r3(gap.distance), at: gap.at, bones: gap.compared }, agrees: gap.distance <= s.tolerance, tolerance: s.tolerance,
          ...(s.known && explained ? { known: { why: s.known.why, remaining: r3(explained.distance), at: explained.at, explained: explained.distance <= s.tolerance } } : {}),
          answers: { v2: newAnswers.map(brief), v1: oldAnswers.map(brief) },
        });
      } catch (err) {
        row.error = err instanceof Error ? err.message.split("\n")[0] : String(err);
      }
      report.push(row);
      const p = row.pose as { distance: number; at: string; bones: number } | undefined;
      const k = row.known as { remaining: number; explained: boolean } | undefined;
      console.log(`${s.name.padEnd(46)} ${row.error ? `ERROR ${row.error}` : `${row.agrees ? "agrees" : "differs"}: ${p!.distance} px over ${p!.bones} bones (worst ${p!.at})${row.agrees || !k ? "" : `; the known difference taken out: ${k.remaining} px, ${k.explained ? "AGREES" : "STILL DIFFERS"}`}`}`);
    }
  } finally {
    await browser.close();
    oldBridge.stop();
    newBridge.stop();
    for (const s of servers) s?.kill();
  }
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 1));
  console.log(`report: ${join(OUT, "report.json")}`);
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** A tool's answer, short. */
function brief(a: Record<string, any>): unknown {
  const s = JSON.stringify(a);
  return s.length > 300 ? `${s.slice(0, 300)}…` : a;
}

await main();
