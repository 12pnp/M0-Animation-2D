/**
 * E6's oracle harness (docs/E6-PLAN.md step 1): each corpus rig opened in the old editor (run, never
 * read: its dev server, its File menu) and in v2, written back by each unchanged, and the files
 * compared: equal as JSON, the differences listed by path, and every bone posed at every frame of
 * every animation by v2's engine. Not part of `npm run check`: it needs the old editor's folder.
 *
 * Run: npx vite-node scripts/oracle-parity.ts [filter]   (starts either dev server if it is not up)
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { chromium } from "@playwright/test";
import { atlasImages } from "../src/engine/regions";
import { readAtlas } from "../src/io/atlas";
import { parseJson } from "../src/io/json";
import { readSkeleton } from "../src/io/skeletonRead";
import type { Json } from "../src/model/json";
import { NewEditor, OldEditor, oldEditor, poseGap, ROOT, serve, V1_URL, V2_URL } from "./oracle/editors";

const SAMPLES = join(ROOT, "..", "Packages", "com.module.ta-creator-boneburst", "Tests", "Editor", "Data~", "samples");
const OUT = join(ROOT, "node_modules", ".cache", "oracle-parity");

/** A rig to open: its skeleton, atlas and pages. */
interface Rig { readonly name: string; readonly skeleton: string; readonly atlas: string; readonly pages: string[] }

function corpus(): Rig[] {
  const rigs: Rig[] = [];
  const add = (dir: string, label: string) => {
    const files = readdirSync(dir);
    const atlas = files.find((f) => /\.atlas(\.txt)?$/.test(f));
    if (!atlas) return;
    for (const json of files.filter((f) => f.endsWith(".json") && !f.endsWith(".bb.json"))) {
      rigs.push({ name: `${label}/${json}`, skeleton: join(dir, json), atlas: join(dir, atlas), pages: files.filter((f) => /\.png$/.test(f)).map((f) => join(dir, f)) });
    }
  };
  add(join(ROOT, "tests", "fixtures", "stickman"), "stickman");
  for (const d of readdirSync(SAMPLES, { withFileTypes: true })) if (d.isDirectory()) add(join(SAMPLES, d.name), d.name);
  return rigs;
}

/** Every path where two JSON values differ (numbers equal as float32), up to `max`. */
function differences(a: Json, b: Json, max = 100000): string[] {
  const out: string[] = [];
  const isObj = (v: Json): v is Map<string, Json> => v instanceof Map;
  const walk = (x: Json, y: Json, path: string) => {
    if (out.length >= max) return;
    if (typeof x === "number" && typeof y === "number") { if (Math.fround(x) !== Math.fround(y)) out.push(`${path}: ${x} vs ${y}`); return; }
    if (isObj(x) && isObj(y)) {
      for (const [k, v] of x) if (!y.has(k)) out.push(`${path}/${k}: only in the source`); else walk(v, y.get(k)!, `${path}/${k}`);
      for (const k of y.keys()) if (!x.has(k)) out.push(`${path}/${k}: only in the export`);
      return;
    }
    if (Array.isArray(x) && Array.isArray(y)) {
      // Named lists (bones, slots, skins, constraints) by name; their order apart.
      // (Only the top-level lists, whose names are unique: a constraint by its kind and name.)
      const nameOf = (v: Json) => { const m = v as Map<string, Json>; return path === "/constraints" ? `${String(m.get("type"))}:${String(m.get("name"))}` : String(m.get("name")); };
      const named = (l: Json[]) => ["/bones", "/slots", "/skins", "/constraints"].includes(path) && l.every((v) => isObj(v) && typeof v.get("name") === "string") && new Set(l.map(nameOf)).size === l.length;
      if (named(x) && named(y)) {
        const ys = new Map(y.map((v) => [nameOf(v), v]));
        for (const v of x) { const n = nameOf(v); if (!ys.has(n)) out.push(`${path}/${n}: only in the source`); else walk(v, ys.get(n)!, `${path}/${n}`); }
        for (const v of y) if (!x.some((u) => nameOf(u) === nameOf(v))) out.push(`${path}/${nameOf(v)}: only in the export`);
        if (x.map(nameOf).join("\u0000") !== y.map(nameOf).join("\u0000") && x.length === y.length) out.push(`${path}: order`);
        return;
      }
      if (x.length !== y.length) { out.push(`${path}: ${x.length} items vs ${y.length}`); return; }
      x.forEach((v, i) => walk(v, y[i]!, `${path}/${i}`));
      return;
    }
    if (x !== y) out.push(`${path}: ${JSON.stringify(x)} vs ${JSON.stringify(y)}`);
  };
  walk(a, b, "");
  return out;
}

/** Differences grouped by kind and place (names and indices folded): the shape of what an editor changes. */
function kinds(diffs: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of diffs) {
    const at = d.indexOf(": "), path = d.slice(0, at), what = d.slice(at + 2);
    const nums = /^(-?[\d.e+-]+) vs (-?[\d.e+-]+)$/.exec(what);
    const kind = nums ? (Math.abs(+nums[1]! - +nums[2]!) <= 1e-5 * Math.max(1, Math.abs(+nums[1]!)) ? "float precision" : "number")
      : what === "only in the source" ? "dropped" : what === "only in the export" ? "added" : what === "order" ? "order" : / items vs /.test(what) ? "key count" : "value";
    const place = path.replace(/^\/animations\/[^/]+/, "/animations/*")
      .replace(/^(\/animations\/\*\/(bones|slots|ik|transform|path|physics|slider|attachments))\/[^/]+/, "$1/*")
      .replace(/^\/(bones|slots|skins|constraints)\/[^/]+/, "/$1/*").replace(/\/attachments\/[^/]+\/[^/]+/, "/attachments/*/*").replace(/\/\d+/g, "/#");
    const key = `${kind.padEnd(16)} ${place}`;
    out.set(key, (out.get(key) ?? 0) + 1);
  }
  return out;
}

const r3 = (n: number) => (Number.isFinite(n) ? Math.round(n * 1000) / 1000 : n);

async function main(): Promise<void> {
  const filter = process.argv[2];
  const servers = [await serve(V1_URL, oldEditor()), await serve(V2_URL, ROOT)];
  const browser = await chromium.launch();
  mkdirSync(OUT, { recursive: true });
  const report: Record<string, unknown>[] = [];
  try {
    for (const rig of corpus().filter((r) => !filter || r.name.includes(filter))) {
      const source = readFileSync(rig.skeleton, "utf8");
      const images = atlasImages(readAtlas(readFileSync(rig.atlas, "utf8")));
      const row: Record<string, unknown> = { rig: rig.name };
      try {
        const two2 = await NewEditor.open(browser);
        await two2.open([rig.skeleton, rig.atlas, ...rig.pages]);
        const v2 = await two2.save();
        await two2.close();
        const old = await OldEditor.open(browser);
        await old.openSpine([rig.skeleton, rig.atlas, ...rig.pages]);
        const v1Files = await old.exportFolder();
        await old.close();
        const v1 = new TextDecoder().decode(v1Files.get([...v1Files.keys()].find((k) => k.endsWith(".json"))!)!);
        writeFileSync(join(OUT, `${rig.name.replace(/[/ ]/g, "_")}.v1.json`), v1);
        const src = readSkeleton(source).skeleton, one = readSkeleton(v1), two = readSkeleton(v2).skeleton;
        const v1Diffs = differences(parseJson(source), parseJson(v1));
        const v2Diffs = differences(parseJson(source), parseJson(v2));
        const g1 = poseGap(src, one.skeleton, images), g2 = poseGap(src, two, images);
        Object.assign(row, {
          v1: { files: [...v1Files.keys()], bytesEqual: v1 === source, differences: v1Diffs.length, all: v1Diffs, readIssues: one.issues.length, pose: { distance: r3(g1.distance), at: g1.at } },
          v2: { bytesEqual: v2 === source, differences: v2Diffs.length, first: v2Diffs.slice(0, 4), pose: { distance: r3(g2.distance), at: g2.at } },
        });
      } catch (err) {
        row.error = err instanceof Error ? err.message.split("\n")[0] : String(err);
      }
      report.push(row);
      const v1r = row.v1 as { differences: number; pose: { distance: number } } | undefined, v2r = row.v2 as typeof v1r;
      console.log(`${rig.name.padEnd(42)} ${row.error ? `ERROR ${row.error}` : `v1: ${String(v1r!.differences).padStart(3)} diffs, pose ${v1r!.pose.distance} | v2: ${v2r!.differences} diffs, pose ${v2r!.pose.distance}`}`);
    }
  } finally {
    await browser.close();
    for (const s of servers) s?.kill();
  }
  writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 1));
  // The old editor's changes across the corpus, by kind: how many rigs, how many places.
  const total = new Map<string, { rigs: number; count: number }>();
  for (const row of report) {
    const all = (row.v1 as { all?: string[] } | undefined)?.all;
    if (!all) continue;
    for (const [k, n] of kinds(all)) { const t = total.get(k) ?? { rigs: 0, count: 0 }; total.set(k, { rigs: t.rigs + 1, count: t.count + n }); }
  }
  console.log("\nthe old editor's changes, by kind (rigs, places):");
  for (const [k, t] of [...total].sort((a, b) => b[1].rigs - a[1].rigs || b[1].count - a[1].count).slice(0, 30)) console.log(`${String(t.rigs).padStart(3)} ${String(t.count).padStart(6)}  ${k}`);
  console.log(`report: ${join(OUT, "report.json")} (${basename(OUT)})`);
}

await main();
