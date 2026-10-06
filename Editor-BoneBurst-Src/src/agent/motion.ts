import { keyBone } from "@/edit/boneKeys";
import { addAnimation } from "@/edit/animations";
import type { Edit } from "@/edit/history";
import { boneNumber } from "@/model/defaults";
import type { Skeleton } from "@/model/skeleton";
import { frameTime } from "@/model/timelines";
import { applyEdit } from "./apply";
import { type AgentContext, AgentRefused } from "./context";
import { docOf, fpsOf } from "./read";
import { guessRoles, type MotionClip, retarget, type RigBone, type RigIk } from "./rig/motion";
import handMade from "./rig/motions.json";
import captured from "./rig/motions-bvh.json";

/**
 * The motion tools (E5-PLAN step 6): the motion library (hand-made clips and AnimatedDrawings'
 * motion captures) listed with the roles guessed for the rig, and a clip fitted to the rig as a
 * new animation in one History step, checked against the runtime.
 */

type Args = Record<string, unknown>;

export const CLIPS: readonly MotionClip[] = [...(handMade as unknown as MotionClip[]), ...(captured as unknown as MotionClip[])];

/** The rig as the retarget reads it: bones with their setup pose (local and as posed), IK chains with the way they bend. */
export function rigForMotion(doc: Skeleton, ctx: AgentContext): { bones: RigBone[]; ik: RigIk[] } {
  const posed = new Map(ctx.pose(ctx.view().skin, null, 0).map((b) => [b.name, b]));
  const bones: RigBone[] = (doc.bones ?? []).map((b) => {
    const w = posed.get(b.name)!.world;
    return {
      name: b.name, parent: b.parent ?? null, length: boneNumber(b, "length"),
      local: { x: boneNumber(b, "x"), y: boneNumber(b, "y"), rotation: boneNumber(b, "rotation"), scaleX: boneNumber(b, "scaleX"), scaleY: boneNumber(b, "scaleY"), shearX: boneNumber(b, "shearX"), shearY: boneNumber(b, "shearY") },
      setup: { x: w[4]!, y: w[5]!, rotation: (Math.atan2(w[2]!, w[0]!) * 180) / Math.PI, scaleX: Math.hypot(w[0]!, w[2]!) },
    };
  });
  const ik: RigIk[] = [];
  for (const c of doc.constraints ?? []) {
    if (c.type !== "ik" || !c.bones?.length || !c.target) continue;
    const k: RigIk = { bones: [...c.bones], target: c.target };
    // The way the solver bends a two-bone chain: the constraint's own bendPositive, which the
    // runtime follows; read off the pose it is unknown for a limb drawn straight.
    if (c.bones.length === 2) k.bend = c.bendPositive === false ? -1 : 1;
    ik.push(k);
  }
  return { bones, ik };
}

function listMotions(_args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), names = (doc.bones ?? []).map((b) => b.name);
  const side = guessRoles(names, "side"), front = guessRoles(names, "front");
  return {
    motions: CLIPS.map((c) => ({ name: c.name, description: c.description, view: c.view, frames: c.frames, fps: c.fps, loop: c.loop, roles: Object.keys(c.angles) })),
    guessed: { side: side.map, front: front.map },
    ...(side.notes.length || front.notes.length ? { notes: [...side.notes, ...front.notes] } : {}),
  };
}

function applyMotion(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), fps = fpsOf(doc);
  const clip = CLIPS.find((c) => c.name === args.motion);
  if (!clip) throw new AgentRefused(`There is no motion "${String(args.motion)}"; list_motions has ${CLIPS.map((c) => c.name).join(", ")}.`);
  const name = String(args.animation ?? clip.name);
  if (doc.animations?.some((a) => a.name === name)) throw new AgentRefused(`There is already an animation "${name}": give \`animation\` a new name.`);
  // The guess for the clip's view, with the given roles over it (null leaves a role out).
  const guess = guessRoles((doc.bones ?? []).map((b) => b.name), clip.view);
  const map: Record<string, string> = { ...guess.map };
  for (const [role, bone] of Object.entries((args.map ?? {}) as Record<string, string | null>)) {
    if (bone === null) delete map[role]; else map[role] = bone;
  }
  // Clip frames at the clip's rate become frames at the rig's, unless a length is given.
  const frames = (args.frames as number | undefined) ?? Math.max(1, Math.round((clip.frames * fps) / clip.fps));
  const rig = rigForMotion(doc, ctx);
  let result: ReturnType<typeof retarget>;
  try {
    result = retarget({ clip, bones: rig.bones, ik: rig.ik, map, facing: (args.facing as "right" | "left" | undefined) ?? "right", frames });
  } catch (err) {
    throw new AgentRefused((err as Error).message);
  }
  const setup = new Map((doc.bones ?? []).map((b) => [b.name, b]));
  const edits: Edit<Skeleton>[] = [addAnimation(name)];
  for (const k of result.keys) {
    const b = setup.get(k.bone)!;
    const local = { x: k.x ?? boneNumber(b, "x"), y: k.y ?? boneNumber(b, "y"), rotation: k.rotation ?? boneNumber(b, "rotation"), scaleX: boneNumber(b, "scaleX"), scaleY: boneNumber(b, "scaleY"), shearX: boneNumber(b, "shearX"), shearY: boneNumber(b, "shearY") };
    edits.push(keyBone(name, k.bone, [...(k.rotation !== undefined ? ["rotate" as const] : []), ...(k.x !== undefined ? ["translate" as const] : [])], local, frameTime(k.frame, fps)));
  }
  applyEdit(ctx, `apply_motion ${clip.name} as ${name}`, (s) => edits.reduce((d, e) => e(d), s));
  // The check: the runtime's pose of the new animation against what the retarget posed.
  let worst = 0, worstAt = "";
  for (const e of result.expected) {
    const now = new Map(ctx.pose(ctx.view().skin, name, frameTime(e.frame, fps)).map((b) => [b.name, b.world]));
    for (const [bone, want] of Object.entries(e.bones)) {
      const w = now.get(bone)!, d = Math.hypot(w[4]! - want.x, w[5]! - want.y);
      if (d > worst) { worst = d; worstAt = `${bone} at frame ${e.frame}`; }
    }
  }
  const lowest = result.ground !== undefined ? Math.min(...result.expected.map((e) => e.feet ?? Infinity)) : undefined;
  return {
    animation: name, motion: clip.name, frames, map, ...(result.ground !== undefined ? { ground: round(result.ground), lowestFoot: round(lowest!) } : {}),
    check: { matches: worst <= 0.5, largestDifference: round(worst), ...(worst > 0.5 ? { at: worstAt } : {}) },
    loops: clip.loop, notes: [...guess.notes, ...result.notes],
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

export const MOTION_TOOLS = { list_motions: listMotions, apply_motion: applyMotion } as const;
