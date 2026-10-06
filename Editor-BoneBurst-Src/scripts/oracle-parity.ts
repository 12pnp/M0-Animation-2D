/**
 * E6's oracle harness (docs/E6-PLAN.md step 1): each corpus rig opened in the old editor (run, never
 * read: its dev server, its File menu) and in v2, written back by each unchanged, and the files
 * compared: equal as JSON, the differences listed by path, and every bone posed at every frame of
 * every animation by v2's engine. Not part of `npm run check`: it needs the old editor's folder.
 *
 * Run: npx vite-node scripts/oracle-parity.ts [filter]   (starts either dev server if it is not up)
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, chromium, type Page } from "@playwright/test";
import { poseDifference } from "../src/agent/check";
import { atlasImages, type AtlasImages } from "../src/engine/regions";
import { readAtlas } from "../src/io/atlas";
import { parseJson } from "../src/io/json";
import type { Json } from "../src/model/json";
import { readSkeleton } from "../src/io/skeletonRead";
import type { Skeleton } from "../src/model/skeleton";
import { animationDuration } from "../src/model/timelines";
import { posedBones } from "../src/ui/agent/context";
import { Poser } from "../src/ui/stage/posed";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const V1 = join(ROOT, "..", "Animation-BoneBurst-Src");
const SAMPLES = join(ROOT, "..", "Packages", "com.module.ta-creator-boneburst", "Tests", "Editor", "Data~", "samples");
const OUT = join(ROOT, "node_modules", ".cache", "oracle-parity");
const V1_URL = "http://localhost:5181/", V2_URL = "http://localhost:5185/";

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

async function up(url: string): Promise<boolean> {
  return fetch(url).then((r) => r.ok, () => false);
}

async function serve(url: string, cwd: string): Promise<ChildProcess | null> {
  if (await up(url)) return null;
  const p = spawn("npm", ["run", "dev"], { cwd, stdio: "ignore" });
  for (let i = 0; i < 100 && !(await up(url)); i++) await new Promise((r) => setTimeout(r, 200));
  if (!(await up(url))) throw new Error(`${url} did not start (${cwd}).`);
  return p;
}

/** The old editor: Open Spine…, then Export to Folder… into a recording folder; the written files. */
async function v1Export(browser: Browser, rig: Rig): Promise<Map<string, Uint8Array>> {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(() => {
    const w = window as unknown as Record<string, unknown> & { __written: Record<string, number[]> };
    w.__written = {};
    const bytes = async (d: unknown): Promise<Uint8Array> => (d instanceof Blob ? new Uint8Array(await d.arrayBuffer())
      : typeof d === "string" ? new TextEncoder().encode(d)
        : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array((d as ArrayBufferView).buffer));
    const file = (name: string) => ({
      kind: "file", name,
      async createWritable() {
        const parts: Uint8Array[] = [];
        return {
          async write(d: unknown) { parts.push(await bytes(d)); },
          async close() { w.__written[name] = parts.flatMap((p) => Array.from(p)); },
        };
      },
      async queryPermission() { return "granted"; }, async requestPermission() { return "granted"; },
    });
    const dir = (name: string): unknown => ({
      kind: "directory", name,
      async getFileHandle(n: string) { return file(n); }, async getDirectoryHandle(n: string) { return dir(n); },
      async queryPermission() { return "granted"; }, async requestPermission() { return "granted"; },
      async *values() { /* empty */ }, async *entries() { /* empty */ },
    });
    w.showDirectoryPicker = async () => dir("Out");
  });
  const p = await ctx.newPage();
  p.on("dialog", (d) => void d.dismiss());
  await p.goto(V1_URL);
  await p.getByText("File", { exact: true }).first().click();
  const [chooser] = await Promise.all([p.waitForEvent("filechooser"), p.getByText("Open Spine…", { exact: true }).click()]);
  await chooser.setFiles([rig.skeleton, rig.atlas, ...rig.pages]);
  await p.waitForTimeout(1500);
  await p.getByText("File", { exact: true }).first().click();
  await p.getByText("Export to Folder…", { exact: true }).click();
  const written = await waitFor(p, () => (window as unknown as { __written: Record<string, number[]> }).__written, (w) => Object.keys(w).some((k) => k.endsWith(".json")));
  await ctx.close();
  return new Map(Object.entries(written).map(([k, v]) => [k, Uint8Array.from(v)]));
}

/** v2: the files given to its file input, then Save; the skeleton it downloads. */
async function v2Export(browser: Browser, rig: Rig): Promise<string> {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  await p.goto(V2_URL);
  await p.locator("header input[type=file]").setInputFiles([rig.skeleton, rig.atlas, ...rig.pages]);
  await p.waitForFunction(() => document.title.includes(".json"));
  const [download] = await Promise.all([p.waitForEvent("download"), p.getByRole("button", { name: "Save" }).click()]);
  const text = readFileSync(await download.path(), "utf8");
  await ctx.close();
  return text;
}

async function waitFor<T>(p: Page, read: () => T, done: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await p.evaluate(read);
    if (done(v) || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 200));
  }
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

/** The largest distance between the two files' poses: every animation, every frame at 30 fps, the default skin and each other. */
function poseGap(a: Skeleton, b: Skeleton, images: AtlasImages): { distance: number; at: string } {
  const pa = new Poser(a, images), pb = new Poser(b, images);
  let worst = { distance: 0, at: "" };
  const skins = [null, ...(a.skins ?? []).map((k) => k.name).filter((n) => n !== "default")].slice(0, 4);
  for (const skin of skins) {
    for (const anim of [null, ...(a.animations ?? []).map((x) => x.name)]) {
      if (anim && !b.animations?.some((x) => x.name === anim)) { worst = { distance: Infinity, at: `${anim} missing` }; continue; }
      const end = anim ? animationDuration(a.animations!.find((x) => x.name === anim)!) : 0;
      for (let f = 0; f <= Math.round(end * 30); f++) {
        const t = Math.fround(f / 30);
        const d = poseDifference(posedBones(pa.pose(skin, anim, t)), posedBones(pb.pose(skin, anim, t)));
        if (d.distance > worst.distance) worst = { distance: d.distance, at: `${skin ?? "default"} ${anim ?? "setup"} frame ${f} ${d.bone}` };
      }
    }
  }
  return worst;
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
  if (!existsSync(V1)) throw new Error(`The old editor is not at ${V1}.`);
  const filter = process.argv[2];
  const servers = [await serve(V1_URL, V1), await serve(V2_URL, ROOT)];
  const browser = await chromium.launch();
  mkdirSync(OUT, { recursive: true });
  const report: Record<string, unknown>[] = [];
  try {
    for (const rig of corpus().filter((r) => !filter || r.name.includes(filter))) {
      const source = readFileSync(rig.skeleton, "utf8");
      const images = atlasImages(readAtlas(readFileSync(rig.atlas, "utf8")));
      const row: Record<string, unknown> = { rig: rig.name };
      try {
        const v2 = await v2Export(browser, rig);
        const v1Files = await v1Export(browser, rig);
        const v1Name = [...v1Files.keys()].find((k) => k.endsWith(".json"))!;
        const v1 = new TextDecoder().decode(v1Files.get(v1Name)!);
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
