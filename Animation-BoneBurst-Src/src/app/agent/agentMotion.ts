import type { NodeId } from "@/core/doc/ids";
import type { Node } from "@/core/doc/types";
import { ikChain, ikRoles } from "@/core/doc/ikGraph";
import { guessRoles, type RigBone, retarget } from "@/core/rig/motion";
import { isCycle } from "@/core/doc/cycle";
import { posedSymbol } from "@/core/boneburst/boneburstPose";
import { toBoneBurstLocal } from "@/core/boneburst/transform";
import { AgentError, int, round, type Args } from "./agentArgs";
import type { AgentApi } from "./AgentApi";
import type { MotionClip } from "@/core/rig/motion";
import MOTIONS from "@/core/rig/motions.json";
import BVH_MOTIONS from "@/core/rig/motions-bvh.json";
import { newAnimation, setKeys } from "./agentKeys";

/** The hand-made clips (`scripts/buildMotions.ts`), then mocap converted from BVH
 *  (`scripts/buildBvhMotions.ts`, AnimatedDrawings' example takes). */
export const MOTION_CLIPS = [...MOTIONS, ...BVH_MOTIONS] as unknown as MotionClip[];

/**
 * The AI's motion library: clips retargeted onto the rig.
 */

/* ── motions ── */

/** Bones a clip may move: real bones, not IK targets. */
export function motionBones(api: AgentApi): Node[] {
  const { targets } = ikRoles(api.sym);
  return api.bones().filter((n) => n.kind === "bone" && !targets.has(n.id));
}

export function listMotions(api: AgentApi) {
  const names = motionBones(api).map((n) => n.name);
  return {
    motions: MOTION_CLIPS.map((c) => ({ name: c.name, description: c.description, view: c.view, frames: c.frames, fps: c.fps, roles: Object.keys(c.angles) })),
    guess: { side: guessRoles(names, "side").map, front: guessRoles(names, "front").map },
    note: "apply_motion maps roles to bones by these guesses unless you give map; check them against get_rig.",
  };
}

export function applyMotion(api: AgentApi, motion: string, args: Args) {
  const clip = MOTION_CLIPS.find((c) => c.name === motion);
  if (!clip) throw new AgentError(`There is no motion "${motion}". list_motions lists them.`);
  const name = typeof args.animation === "string" ? args.animation : motion;
  if (api.sym.animations.some((a) => a.name === name)) throw new AgentError(`There is already an animation "${name}": give another name.`);
  const facing = args.facing ?? "right";
  if (facing !== "right" && facing !== "left") throw new AgentError(`facing is "right" or "left".`);
  const fps = api.store.project.frameRate;
  const frames = args.frames === undefined ? Math.max(1, Math.round((clip.frames * fps) / clip.fps)) : int(args, "frames", 1);

  const guess = guessRoles(motionBones(api).map((n) => n.name), clip.view);
  const map: Record<string, string> = { ...guess.map };
  if (args.map !== undefined) {
    if (!args.map || typeof args.map !== "object" || Array.isArray(args.map)) throw new AgentError(`map is an object of role → bone, e.g. {"thigh.near": "leg_l_up"}.`);
    for (const [role, bone] of Object.entries(args.map)) {
      if (bone === null) { delete map[role]; continue; }
      if (typeof bone !== "string") throw new AgentError(`map.${role} is a bone name, or null to leave the role out.`);
      if (api.bone(bone).kind !== "bone") throw new AgentError(`"${bone}" is a slot; map roles to bones.`);
      map[role] = bone;
    }
  }
  if (Object.keys(map).length === 0) throw new AgentError("No bone is mapped to a role; give map (list_motions lists the roles).");

  const s = api.sym;
  const setup = posedSymbol(api.store.project, s, null, 0, "setup");
  const rig: RigBone[] = api.bones().map((n) => {
    const m = setup.byNode.get(n.id)?.world;
    return {
      name: n.id, parent: n.parentId && s.nodes[n.parentId] ? n.parentId : null, local: toBoneBurstLocal(n.bind), length: n.boneLength ?? 0,
      setup: m ? { x: m.tx, y: -m.ty, rotation: (Math.atan2(-m.b, m.a) * 180) / Math.PI, scaleX: Math.hypot(m.a, m.b) } : { x: 0, y: 0, rotation: 0, scaleX: 1 },
    };
  });
  const idOf = (bone: string) => api.bone(bone).id as string;
  const nameOf = (id: string) => s.nodes[id as NodeId]?.name ?? id;
  let result;
  try {
    result = retarget({
      clip, bones: rig, frames, facing,
      map: Object.fromEntries(Object.entries(map).map(([role, bone]) => [role, idOf(bone)])),
      ik: s.ik.map((k) => {
        const chain = ikChain(s, k);
        // Which way the solver bends it, read off the solved setup pose.
        const [r, e] = chain.map((id) => setup.byNode.get(id)?.world);
        const turn = r && e ? Math.sin(Math.atan2(-e.b, e.a) - Math.atan2(-r.b, r.a)) : 0;
        return { bones: chain as string[], target: k.targetId as string, ...(chain.length === 2 && Math.abs(turn) > 0.02 ? { bend: turn > 0 ? 1 as const : -1 as const } : {}) };
      }),
    });
  } catch (err) {
    throw new AgentError(err instanceof Error ? err.message.replace(/"([^"]+)"/g, (_, id: string) => `"${nameOf(id)}"`) : String(err));
  }

  const label = `AI: Motion "${clip.name}" as "${name}"`;
  api.store.transaction(label, () => {
    newAnimation(api, name, frames);
    setKeys(api, name, result.keys.map((k) => ({ ...k, bone: nameOf(k.bone), ease: "linear" })));
  });

  // What the runtime now shows, against what the retarget posed.
  const anim = api.animation(name);
  let worstDeg = 0, worstPx = 0, at = "";
  for (const e of result.expected) {
    const pose = posedSymbol(api.store.project, s, anim, e.frame, "animate");
    for (const [id, want] of Object.entries(e.bones)) {
      const m = pose.byNode.get(id as NodeId)?.world;
      if (!m) continue;
      const deg = Math.abs(((((Math.atan2(-m.b, m.a) * 180) / Math.PI - want.rotation) % 360) + 540) % 360 - 180);
      const px = Math.hypot(m.tx - want.x, -m.ty - want.y);
      if (deg > worstDeg) { worstDeg = deg; at = `"${nameOf(id)}" at frame ${e.frame}`; }
      worstPx = Math.max(worstPx, px);
    }
  }
  const matches = worstDeg < 1 && worstPx < 1;
  return {
    animation: name, frames, motion: clip.name, facing, cycle: isCycle(api.animation(name)),
    map: Object.fromEntries(Object.entries(map).sort()),
    keys: result.keys.length,
    ...(result.ground !== undefined ? { ground: round(result.ground, 2) } : {}),
    check: { matches, worstDegrees: round(worstDeg, 3), worstPixels: round(worstPx, 3), ...(matches ? {} : { at, hint: "An IK chain may bend the other way (add_ik's bendPositive), or a role is on the wrong bone: look with render_frame." }) },
    notes: [...guess.notes, ...result.notes.map((n) => n.replace(/"([^"]+)"/g, (_, id: string) => `"${nameOf(id)}"`))],
  };
}
