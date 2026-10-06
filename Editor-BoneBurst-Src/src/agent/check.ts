import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import { animationDuration, frameTime, timeFrame } from "@/model/timelines";
import { type AgentContext, AgentRefused, type PosedBone } from "./context";
import { animationOf, docOf, fpsOf } from "./read";

/**
 * `check_preview` (E5-PLAN step 7): would the file play as the editor shows it? The document is
 * written as Save writes it, read back, and posed by a fresh runtime; every bone is compared with
 * the editor's pose at each frame asked. For a loop, `seam` names the bones whose last frame
 * differs from frame 0.
 */

type Args = Record<string, unknown>;

/** The largest distance between the same bones' places in two poses, and the bone. */
export function poseDifference(a: readonly PosedBone[], b: readonly PosedBone[]): { distance: number; bone: string } {
  const other = new Map(b.map((x) => [x.name, x]));
  let distance = 0, bone = "";
  for (const x of a) {
    const y = other.get(x.name);
    if (!y || !x.active) continue;
    // The joint, and the tip (so a turn about the joint shows too).
    const tip = (p: PosedBone): [number, number] => [p.world[4]! + p.world[0]! * p.length, p.world[5]! + p.world[2]! * p.length];
    const [ax, ay] = tip(x), [bx, by] = tip(y);
    const d = Math.max(Math.hypot(x.world[4]! - y.world[4]!, x.world[5]! - y.world[5]!), Math.hypot(ax - bx, ay - by));
    if (d > distance) { distance = d; bone = x.name; }
  }
  return { distance, bone };
}

function checkPreview(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), a = animationOf(doc, args.animation), fps = fpsOf(doc), skin = ctx.view().skin;
  const last = timeFrame(animationDuration(a), fps);
  const frames = (args.frames as number[] | undefined) ?? Array.from({ length: Math.min(last, 120) + 1 }, (_, f) => f);
  const bad = frames.find((f) => f > last);
  if (bad !== undefined) throw new AgentRefused(`"${a.name}" is ${last} frames long; frame ${bad} is past its end.`);
  const read = readSkeleton(writeSkeleton(doc));
  if (read.issues.length) throw new AgentRefused(`The file as written does not read back cleanly: ${read.issues.slice(0, 3).map((i) => `${i.where}: ${i.message}`).join("; ")}.`);
  let worst = { distance: 0, bone: "", frame: 0 };
  for (const f of frames) {
    const t = frameTime(f, fps);
    const d = poseDifference(ctx.pose(skin, a.name, t), ctx.poseOf(read.skeleton, skin, a.name, t));
    if (d.distance > worst.distance) worst = { ...d, frame: f };
  }
  const round = (n: number) => Math.round(n * 1e4) / 1e4;
  // A loop's seam: the bones whose last frame differs from frame 0.
  const start = ctx.pose(skin, a.name, 0), end = new Map(ctx.pose(skin, a.name, frameTime(last, fps)).map((b) => [b.name, b]));
  const seam = last > 0 ? start.filter((b) => { const e = end.get(b.name); return e && b.active && poseDifference([b], [e]).distance > 0.01; }).map((b) => b.name) : [];
  return {
    animation: a.name, frames: frames.length, largestDifference: round(worst.distance), matches: worst.distance <= 0.01,
    ...(worst.distance > 0.01 ? { at: `${worst.bone} at frame ${worst.frame}` } : {}),
    seam, ...(last > 120 && args.frames === undefined ? { note: `Checked frames 0 to 120 of ${last}; pass frames to check others.` } : {}),
  };
}

export const CHECK_TOOLS = { check_preview: checkPreview } as const;
