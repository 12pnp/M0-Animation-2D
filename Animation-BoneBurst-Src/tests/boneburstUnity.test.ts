import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { atlasText } from "@/core/boneburst/atlas";
import { boneburstJson, exportBoneBurst } from "@/core/boneburst/exportBoneBurst";
import { importBoneBurst } from "@/core/boneburst/importBoneBurst";
import { readAtlas } from "@/core/boneburst/runtime/atlasRead";
import { readRig } from "@/core/boneburst/runtime/rigData";
import { Rig } from "@/core/boneburst/runtime/rig";
import { Track } from "@/core/boneburst/runtime/track";
import { loadFixture } from "./fixtures/realProject";
import { loadStickman } from "./fixtures/stickman";
import { imagesOf, sampleRigs } from "./fixtures/spineSamples";
import { type Json, trimmedPage } from "./fixtures/runtimeOracle";

/**
 * The editor's exports played by the runtime the game ships: BoneBurst's C# runtime
 * (the Unity package `com.module.ta-creator-boneburst`), through its strict-float
 * parity harness on .NET (`Tools~/ParityHarness/run.sh --dump`, `Dump.cs`), compared
 * frame by frame with this editor's runtime (docs/BONEBURST-PIPELINE-PLAN.md R2).
 * Files go across, never code. Skipped, not passed, without the harness's .NET SDK
 * (the Unity version's) or the project's `Library/`.
 *
 * Inputs, closest to the pipeline first: spine-unity's samples opened in the editor
 * and exported again (an artist's file through the editor), the stickman and frog
 * exports (authored here), and the samples as they are (both runtimes reading one file).
 */

const ROOT = resolve(__dirname, "../..");
const HARNESS = join(ROOT, "Packages/com.module.ta-creator-boneburst/Tools~/ParityHarness/run.sh");

function harnessReady(): boolean {
  if (!existsSync(HARNESS) || !existsSync(join(ROOT, "Library/ScriptAssemblies/Unity.Collections.dll"))) return false;
  const version = /m_EditorVersion: (\S+)/.exec(readFileSync(join(ROOT, "ProjectSettings/ProjectVersion.txt"), "utf8"))?.[1];
  return !!version && existsSync(`/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/Resources/Scripting/DotNetSdk/dotnet`);
}

/** As Dump.cs steps: off the 1/30 grid keys sit on, so no frame lands on a key. */
const STEP = Math.fround(0.0337);

interface Frame { w: Array<number[] | null>; c: number[][]; a: Array<string | null>; o: number[] }
interface Input { name: string; json: Json; atlas: string }

/** Every input file, by the name the harness writes its poses under. */
async function inputs(): Promise<Input[]> {
  const out: Input[] = [];
  for (const r of sampleRigs()) {
    const original = JSON.parse(r.json) as Json;
    const exported = exportBoneBurst(importBoneBurst(original, r.name, imagesOf(r.atlas)).project);
    out.push({ name: `reexport-${r.name}`, json: JSON.parse(boneburstJson(exported.skeleton)) as Json, atlas: r.atlas });
    out.push({ name: `sample-${r.name}`, json: original, atlas: r.atlas });
  }
  for (const [name, load] of [["stickman", loadStickman], ["frog", loadFixture]] as const) {
    const { project } = await load();
    const exported = exportBoneBurst(project, project.rootSymbolId);
    out.push({ name, json: JSON.parse(boneburstJson(exported.skeleton)) as Json, atlas: atlasText([trimmedPage(project, exported.usedImages)]) });
  }
  return out;
}

/** The editor's runtime stepped as Dump.cs steps BoneBurst's: 0 s, then `STEP` a frame. */
function play(input: Input, animation: string, count: number): Frame[] {
  const rig = new Rig(readRig(input.json, readAtlas(input.atlas)));
  const track = new Track();
  rig.setupPose();
  track.start(rig.animation(animation)!, false);
  const frames: Frame[] = [];
  for (let f = 0; f < count; f++) {
    const dt = f === 0 ? 0 : STEP;
    track.advance(dt);
    track.apply(rig);
    rig.update(dt);
    rig.updateWorld("update");
    frames.push({
      w: rig.data.bones.map((b) => (rig.active[b.index] ? Array.from(rig.world.subarray(b.index * 6, b.index * 6 + 6)) : null)),
      c: rig.data.slots.map((s) => Array.from(rig.color.subarray(s.index * 7, s.index * 7 + 4))),
      a: rig.data.slots.map((s) => rig.attachmentOf(s.index)?.name ?? null),
      o: [...rig.drawOrder],
    });
  }
  return frames;
}

interface Worst { matrix: number; position: number; color: number; frames: number }

function compareFile(input: Input, theirs: Record<string, Frame[]>, worst: Worst): void {
  for (const [animation, frames] of Object.entries(theirs)) {
    const mine = play(input, animation, frames.length);
    frames.forEach((t, f) => {
      const m = mine[f]!, where = `${input.name} "${animation}" frame ${f}`;
      let size = 1;
      for (const w of m.w) if (w) size = Math.max(size, Math.abs(w[4]!), Math.abs(w[5]!));
      t.w.forEach((tw, b) => {
        const mw = m.w[b];
        if (!tw || !mw) { if (!tw !== !mw) throw new Error(`${where}: bone ${b} active ${!!mw} vs ${!!tw}`); return; }
        for (let j = 0; j < 6; j++) {
          const d = Math.abs(mw[j]! - tw[j]!);
          if (j < 4) worst.matrix = Math.max(worst.matrix, d); else worst.position = Math.max(worst.position, d / size);
          // float32 against float64: matrices to 1e-3, positions to 1e-4 of the rig's size.
          if (j < 4 ? d > 1e-3 : d > 1e-4 * size) throw new Error(`${where}: bone ${input.json.bones ? ((input.json.bones as Json[])[b]?.name as string) : b} ${mw} vs ${tw}`);
        }
      });
      t.c.forEach((tc, s) => {
        for (let j = 0; j < 4; j++) {
          const d = Math.abs(m.c[s]![j]! - tc[j]!);
          worst.color = Math.max(worst.color, d);
          if (d > 1e-4) throw new Error(`${where}: slot ${s} colour ${m.c[s]} vs ${tc}`);
        }
      });
      // What is drawn: a slot on an inactive bone (a skin-only bone no shown skin enables)
      // draws nothing, though the C# pose still names its attachment.
      const slotBones = (input.json.slots as Json[]).map((sl) => (input.json.bones as Json[]).findIndex((bn) => bn.name === sl.bone));
      t.a = t.a.map((n, s) => (t.w[slotBones[s]!] ? n : null));
      if (m.a.join("\u0000") !== t.a.join("\u0000")) {
        const s = m.a.findIndex((n, i) => n !== t.a[i]);
        throw new Error(`${where}: slot ${s} shows ${m.a[s]} vs ${t.a[s]}`);
      }
      if (m.o.join() !== t.o.join()) throw new Error(`${where}: draw order ${m.o} vs ${t.o}`);
      worst.frames++;
    });
  }
}

describe.skipIf(!harnessReady())("the editor's exports in BoneBurst's C# runtime", () => {
  let files: Input[] = [];
  let out = "";
  /** The harness's report: one `DUMP name: …` line per file, a failure's reason included. */
  let log = "";

  beforeAll(async () => {
    files = await inputs();
    const dir = mkdtempSync(join(tmpdir(), "boneburst-r2-"));
    const inDir = join(dir, "in");
    out = join(dir, "out");
    execFileSync("mkdir", ["-p", inDir]);
    for (const f of files) {
      writeFileSync(join(inDir, `${f.name}.json`), JSON.stringify(f.json));
      writeFileSync(join(inDir, `${f.name}.atlas`), f.atlas);
    }
    try {
      log = execFileSync("bash", [HARNESS, "--dump", inDir, out], { stdio: "pipe", timeout: 600_000 }).toString();
    } catch (err) {
      // A file the C# reader refuses fails the run; its line says why, and its case fails with it.
      log = String((err as { stdout?: Buffer }).stdout ?? err);
    }
  }, 600_000);

  const cases = ["stickman", "frog", ...sampleRigs().flatMap((r) => [`reexport-${r.name}`, `sample-${r.name}`])];
  it.each(cases)("%s", (name) => {
    const input = files.find((f) => f.name === name)!;
    const poses = join(out, `${name}.poses.json`);
    if (!existsSync(poses)) throw new Error(log.split("\n").find((l) => l.startsWith(`DUMP ${name}:`))?.slice(0, 600) ?? `no poses for ${name}:\n${log.slice(0, 2000)}`);
    const theirs = (JSON.parse(readFileSync(poses, "utf8")) as { animations: Record<string, Frame[]> }).animations;
    const worst: Worst = { matrix: 0, position: 0, color: 0, frames: 0 };
    compareFile(input, theirs, worst);
    expect(worst.frames).toBeGreaterThan(0);
  });
});
