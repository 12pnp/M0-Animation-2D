/**
 * The two editors as E6's harness drives them (docs/E6-PLAN.md): the old one run as a program
 * (its dev server, its menus, its bridge), never read; v2 the same way; and the comparison of what
 * they write, by pose. Shared by `scripts/oracle-parity.ts` (round trips) and
 * `scripts/oracle-edits.ts` (edit scripts).
 */
import { type ChildProcess, execFileSync, execSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import { poseDifference } from "../../src/agent/check";
import type { PosedBone } from "../../src/agent/context";
import type { AtlasImages } from "../../src/engine/regions";
import type { Skeleton } from "../../src/model/skeleton";
import { animationDuration } from "../../src/model/timelines";
import { posedBones } from "../../src/ui/agent/context";
import { Poser } from "../../src/ui/stage/posed";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** The tag the old editor is archived at (E6-PLAN step 7, D8): it is no longer in `main`. */
export const V1_TAG = "old-editor-final";
const REPO = join(ROOT, "..");
/** Where the oracle scripts keep it, extracted from the tag (ignored). */
const V1_HOME = join(REPO, ".oracle-v1");
export const V1 = join(V1_HOME, "Animation-BoneBurst-Src");

/**
 * The old editor's folder, ready to run: extracted from its tag when it is missing or was taken
 * from another commit, its packages installed when they are missing or its lockfile changed.
 * Only that folder is extracted (`git archive`), not the rest of the repository.
 */
export function oldEditor(): string {
  const commit = execFileSync("git", ["rev-parse", `${V1_TAG}^{commit}`], { cwd: REPO, encoding: "utf8" }).trim();
  const stampFile = join(V1_HOME, "stamp.json");
  const stamp = existsSync(stampFile) ? JSON.parse(readFileSync(stampFile, "utf8")) as { commit?: string; lock?: string } : {};
  if (stamp.commit !== commit || !existsSync(join(V1, "package.json"))) {
    console.log(`Extracting the old editor from ${V1_TAG} (${commit.slice(0, 7)}) into ${V1}…`);
    mkdirSync(V1, { recursive: true });
    // Everything but its packages, so a file the tag no longer has does not linger.
    for (const name of readdirSync(V1)) if (name !== "node_modules") rmSync(join(V1, name), { recursive: true, force: true });
    execSync(`git archive --format=tar ${commit} Animation-BoneBurst-Src | tar -x -C "${V1_HOME}"`, { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] });
  }
  const lock = createHash("sha256").update(readFileSync(join(V1, "package-lock.json"))).digest("hex");
  if (stamp.lock !== lock || !existsSync(join(V1, "node_modules"))) {
    console.log("Installing its packages (npm ci)…");
    execFileSync("npm", ["ci", "--no-audit", "--no-fund"], { cwd: V1, stdio: ["ignore", "ignore", "inherit"] });
  }
  writeFileSync(stampFile, JSON.stringify({ commit, lock }));
  return V1;
}
export const V1_URL = "http://localhost:5181/", V2_URL = "http://localhost:5185/";
/** The old editor's page talks to its bridge on this port only. */
export const V1_BRIDGE_PORT = 5190;

export async function up(url: string): Promise<boolean> {
  return fetch(url).then((r) => r.ok, () => false);
}

/** The dev server at `url`, started from `cwd` when it is not up; the process to stop, or null. */
export async function serve(url: string, cwd: string): Promise<ChildProcess | null> {
  if (await up(url)) return null;
  const p = spawn("npm", ["run", "dev"], { cwd, stdio: "ignore" });
  for (let i = 0; i < 100 && !(await up(url)); i++) await new Promise((r) => setTimeout(r, 200));
  if (!(await up(url))) throw new Error(`${url} did not start (${cwd}).`);
  return p;
}

/** A page script: the folder picker answered by a folder that records what is written into it (`window.__written`). */
function recordingFolder(): void {
  const w = window as unknown as Record<string, unknown> & { __written: Record<string, number[]> };
  w.__written = {};
  const bytes = async (d: unknown): Promise<Uint8Array> => (d instanceof Blob ? new Uint8Array(await d.arrayBuffer())
    : typeof d === "string" ? new TextEncoder().encode(d)
      : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array((d as ArrayBufferView).buffer));
  const file = (name: string) => ({
    kind: "file", name,
    async createWritable() {
      const parts: Uint8Array[] = [];
      return { async write(d: unknown) { parts.push(await bytes(d)); }, async close() { w.__written[name] = parts.flatMap((p) => Array.from(p)); } };
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
}

/** The old editor, open in a fresh context (its saved work elsewhere untouched). */
export class OldEditor {
  private constructor(readonly ctx: BrowserContext, readonly page: Page) {}

  static async open(browser: Browser): Promise<OldEditor> {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addInitScript(recordingFolder);
    const page = await ctx.newPage();
    page.on("dialog", (d) => void d.dismiss());
    await page.goto(V1_URL);
    await page.waitForTimeout(800);
    return new OldEditor(ctx, page);
  }

  private async menu(top: string, item: string): Promise<void> {
    await this.page.getByText(top, { exact: true }).first().click();
    await this.page.getByText(item, { exact: true }).first().click();
  }

  private async choose(top: string, item: string, files: readonly string[]): Promise<void> {
    await this.page.getByText(top, { exact: true }).first().click();
    const [chooser] = await Promise.all([this.page.waitForEvent("filechooser"), this.page.getByText(item, { exact: true }).click()]);
    await chooser.setFiles([...files]);
    await this.page.waitForTimeout(1500);
  }

  /** File ▸ Open Spine…: a skeleton with its atlas and pages. */
  openSpine(files: readonly string[]): Promise<void> { return this.choose("File", "Open Spine…", files); }
  /** File ▸ Import PSD as Layers…: one layer per picture, as `auto_rig` takes them. */
  importPsd(file: string): Promise<void> { return this.choose("File", "Import PSD as Layers…", [file]); }

  /** The document's frame rate, in the Properties panel's FPS field. */
  async setFps(fps: number): Promise<void> {
    const field = this.page.getByText("FPS", { exact: true }).first().locator("xpath=following::input[1]");
    await field.fill(String(fps));
    await field.press("Enter");
  }

  /** AI ▸ Connect to AI, and wait until its bridge sees the page. */
  async connect(): Promise<void> {
    await this.menu("AI", "Connect to AI");
    for (let i = 0; i < 60; i++) {
      const s = await fetch(`http://127.0.0.1:${V1_BRIDGE_PORT}/agent/status`).then((r) => r.json() as Promise<{ editor: boolean }>, () => ({ editor: false }));
      if (s.editor) return;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("The old editor did not connect to its bridge.");
  }

  /** File ▸ Export to Folder…: the files written, by name. */
  async exportFolder(): Promise<Map<string, Uint8Array>> {
    await this.page.evaluate(() => { (window as unknown as { __written: object }).__written = {}; });
    await this.menu("File", "Export to Folder…");
    for (let i = 0; i < 50; i++) {
      const w = await this.page.evaluate(() => (window as unknown as { __written: Record<string, number[]> }).__written);
      if (Object.keys(w).some((k) => k.endsWith(".json"))) return new Map(Object.entries(w).map(([k, v]) => [k, Uint8Array.from(v)]));
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error("The old editor wrote no skeleton.");
  }

  /** The skeleton it exports, as text. */
  async exportSkeleton(): Promise<string> {
    const files = await this.exportFolder();
    return new TextDecoder().decode(files.get([...files.keys()].find((k) => k.endsWith(".json"))!)!);
  }

  close(): Promise<void> { return this.ctx.close(); }
}

/** v2, open in a fresh context, talking to the bridge on `bridgePort` when given. */
export class NewEditor {
  private constructor(readonly ctx: BrowserContext, readonly page: Page) {}

  static async open(browser: Browser, bridgePort?: number): Promise<NewEditor> {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true });
    const page = await ctx.newPage();
    await page.goto(bridgePort ? `${V2_URL}?bridge=${bridgePort}` : V2_URL);
    return new NewEditor(ctx, page);
  }

  /** Files through the toolbar's file input (a skeleton with its atlas and pages, or a PSD). */
  async open(files: readonly string[]): Promise<void> {
    await this.page.locator("header input[type=file]").setInputFiles([...files]);
    await this.page.waitForFunction(() => document.title.includes(".json"));
  }

  /** The toolbar's AI button, and wait until connected. */
  async connect(): Promise<void> {
    await this.page.locator(".ai-button").click();
    await this.page.waitForFunction(() => document.querySelector(".ai-button")?.getAttribute("data-state") === "connected");
  }

  /** Save: the skeleton it downloads, as text. */
  async save(): Promise<string> {
    const [download] = await Promise.all([this.page.waitForEvent("download"), this.page.getByRole("button", { name: "Save" }).click()]);
    const { readFileSync } = await import("node:fs");
    return readFileSync(await download.path(), "utf8");
  }

  close(): Promise<void> { return this.ctx.close(); }
}

/** An editor's bridge, started as an MCP client starts it: MCP on its stdio. */
export class Bridge {
  private buffer = "";
  private id = 0;
  private readonly waiting = new Map<number, (m: { result?: Record<string, unknown>; error?: { message: string } }) => void>();

  constructor(private readonly proc: ChildProcess) {
    proc.stdout!.setEncoding("utf8");
    proc.stdout!.on("data", (chunk: string) => {
      this.buffer += chunk;
      for (let nl = this.buffer.indexOf("\n"); nl >= 0; nl = this.buffer.indexOf("\n")) {
        const msg = JSON.parse(this.buffer.slice(0, nl));
        this.buffer = this.buffer.slice(nl + 1);
        this.waiting.get(msg.id)?.(msg);
        this.waiting.delete(msg.id);
      }
    });
  }

  /** `script` run with its own home and key file, on `port`; waits until it answers. */
  static async start(script: string, port: number): Promise<Bridge> {
    const home = mkdtempSync(join(tmpdir(), "oracle-bridge-"));
    const proc = spawn(process.execPath, [script], {
      stdio: ["pipe", "pipe", "ignore"],
      env: { PATH: process.env.PATH ?? "", HOME: home, BONEBURST_BRIDGE_PORT: String(port), BONEBURST_KEYFILE: join(home, "keys.json"), BONEBURST_CALL_TIMEOUT: "60000" },
    });
    for (let i = 0; i < 50 && !(await up(`http://127.0.0.1:${port}/agent/status`)); i++) await new Promise((r) => setTimeout(r, 100));
    if (!(await up(`http://127.0.0.1:${port}/agent/status`))) throw new Error(`The bridge ${script} did not start on ${port} (is one already running there?).`);
    const b = new Bridge(proc);
    await b.rpc("initialize", { protocolVersion: "2025-06-18" });
    return b;
  }

  rpc(method: string, params?: unknown): Promise<Record<string, unknown>> {
    const id = ++this.id;
    return new Promise((done, fail) => {
      this.waiting.set(id, (m) => (m.error ? fail(new Error(m.error.message)) : done(m.result!)));
      this.proc.stdin!.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`);
    });
  }

  /** A tool's answer, parsed; a refusal thrown with its words. */
  async tool(name: string, args: unknown): Promise<Record<string, any>> {
    const r = await this.rpc("tools/call", { name, arguments: args }) as { content: { type: string; text?: string }[]; isError?: boolean };
    const text = r.content.find((c) => c.type === "text")?.text ?? "";
    if (r.isError) throw new Error(`${name} refused: ${text}`);
    return JSON.parse(text);
  }

  stop(): void { this.proc.kill(); }
}

/** Each frame to pose: every animation (or the given ones) at 30 fps, and the setup pose. */
function frames(doc: Skeleton, animations?: readonly string[]): { anim: string | null; frame: number; time: number }[] {
  const out: { anim: string | null; frame: number; time: number }[] = [{ anim: null, frame: 0, time: 0 }];
  for (const a of doc.animations ?? []) {
    if (animations && !animations.includes(a.name)) continue;
    for (let f = 0; f <= Math.round(animationDuration(a) * 30); f++) out.push({ anim: a.name, frame: f, time: Math.fround(f / 30) });
  }
  return out;
}

/** `bones` moved by (dx, dy). */
const moved = (bones: readonly PosedBone[], dx: number, dy: number): PosedBone[] => bones.map((b) => ({ ...b, world: [b.world[0]!, b.world[1]!, b.world[2]!, b.world[3]!, b.world[4]! + dx, b.world[5]! + dy] }));

/**
 * The largest distance between two files' poses: the bones both have (by name), every frame of
 * `animations` (all of `a`'s when not given), the default skin and up to three others; `b` moved
 * by `offset` first (the two editors' origins apart); bones in `skip` left out.
 */
export function poseGap(a: Skeleton, b: Skeleton, images: AtlasImages, o: { animations?: readonly string[]; offset?: readonly [number, number]; imagesB?: AtlasImages; skip?: readonly string[] } = {}): { distance: number; at: string; compared: number } {
  const pa = new Poser(a, images), pb = new Poser(b, o.imagesB ?? images);
  const [dx, dy] = o.offset ?? [0, 0];
  let worst = { distance: 0, at: "", compared: 0 };
  const skins = [null, ...(a.skins ?? []).map((k) => k.name).filter((n) => n !== "default")].slice(0, 4);
  for (const skin of skins) {
    for (const { anim, frame, time } of frames(a, o.animations)) {
      if (anim && !b.animations?.some((x) => x.name === anim)) return { distance: Infinity, at: `${anim}: missing`, compared: 0 };
      const keep = (x: PosedBone) => !o.skip?.includes(x.name);
      const ba = posedBones(pa.pose(skin, anim, time)).filter(keep);
      // Tips at `a`'s lengths: a bone's length is setup data (the JSON compare has it), not pose.
      const length = new Map(ba.map((x) => [x.name, x.length]));
      const bb = moved(posedBones(pb.pose(skin, anim, time)), -dx, -dy).filter(keep).map((x) => ({ ...x, length: length.get(x.name) ?? x.length }));
      const names = new Set(bb.map((x) => x.name));
      worst.compared = ba.filter((x) => names.has(x.name)).length;
      const d = poseDifference(ba, bb);
      if (d.distance > worst.distance) worst = { distance: d.distance, at: `${skin ?? "default"} ${anim ?? "setup"} frame ${frame} ${d.bone}`, compared: worst.compared };
    }
  }
  return worst;
}
