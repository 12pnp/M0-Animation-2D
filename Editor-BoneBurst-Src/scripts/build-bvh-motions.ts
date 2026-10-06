/**
 * Writes `src/agent/rig/motions-bvh.json`: AnimatedDrawings' example mocap
 * (`../../AnimatedDrawings/examples/bvh`, MIT, Meta) as library clips
 * `apply_motion` retargets, converted by `agent/rig/bvhClip.ts`. Each take's up
 * axis and frame range come from its motion config there. The CMU take is
 * left out: CMU's data is free to use, not to redistribute.
 * Run: npx vite-node scripts/build-bvh-motions.ts [path to AnimatedDrawings]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseBvh } from "@/agent/rig/bvh";
import { type BvhClipOptions, bvhClip } from "@/agent/rig/bvhClip";
import type { MotionClip } from "@/agent/rig/motion";

const ad = process.argv[2] ?? fileURLToPath(new URL("../../../AnimatedDrawings", import.meta.url));

/** `config`: the take's motion config in AnimatedDrawings (up axis, frame range). */
const TAKES: Array<{ config: string; seconds?: number } & Pick<BvhClipOptions, "name" | "description" | "view">> = [
  { config: "wave_hello", name: "wave_hello", view: "front", description: "Front view, mocap (FAIR): arms out, then a wave hello with one hand. Seven seconds." },
  { config: "dab", name: "dab", view: "front", description: "Front view, mocap (FAIR): a dab, the head ducked into one elbow, the other arm thrown out." },
  { config: "jumping", name: "jumping", view: "front", description: "Front view, mocap (FAIR): repeated jumps in place, the feet leaving the ground." },
  { config: "zombie", name: "zombie_walk", view: "side", seconds: 6, description: "Side view, facing right, mocap (FAIR): a shambling zombie walk, the arms held forward. Six seconds." },
  { config: "jesse_dance", name: "dance", view: "front", description: "Front view, mocap (Rokoko, from phone video): a ten-second dance." },
];

/** The two keys of AnimatedDrawings' motion configs this needs. */
function config(name: string): { file: string; up: BvhClipOptions["up"]; start?: number | undefined; end?: number | undefined } {
  const text = readFileSync(join(ad, "examples/config/motion", `${name}.yaml`), "utf8");
  const field = (k: string) => /^(\S+):\s*(.*)$/m.exec(text.split("\n").find((l) => l.startsWith(`${k}:`)) ?? "")?.[2]?.trim();
  const int = (k: string) => { const v = field(k); return v && v !== "null" ? Number(v) : undefined; };
  return { file: field("filepath")!, up: field("up") as BvhClipOptions["up"], start: int("start_frame_idx"), end: int("end_frame_idx") };
}

const clips: MotionClip[] = TAKES.map((t) => {
  const c = config(t.config);
  const bvh = parseBvh(readFileSync(join(ad, c.file), "utf8"));
  // A long take is cut to `seconds`: a library clip is a few cycles, not the whole session.
  const end = t.seconds ? Math.min(c.end ?? Infinity, (c.start ?? 0) + Math.round(t.seconds / bvh.frameTime)) : c.end;
  return bvhClip(bvh, { name: t.name, description: t.description, view: t.view, up: c.up, ...(c.start !== undefined ? { start: c.start } : {}), ...(end !== undefined ? { end } : {}) });
});

const out = fileURLToPath(new URL("../src/agent/rig/motions-bvh.json", import.meta.url));
writeFileSync(out, JSON.stringify(clips) + "\n");
console.log(`${clips.length} clips → ${out}: ${clips.map((c) => `${c.name} (${c.frames} frames)`).join(", ")}`);
