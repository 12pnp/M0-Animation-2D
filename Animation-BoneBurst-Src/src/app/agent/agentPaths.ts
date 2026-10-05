import type { Animation, Node } from "@/core/doc/types";
import { keyIndexAt } from "@/core/doc/timeline";
import { bonePaths, keyedIn, pathFrames } from "@/core/doc/bonePath";
import { easesToSpline, type Spline, straightSpline, withSpline } from "@/core/doc/pathSpline";
import { pathDragMode } from "@/core/doc/pathEdit";
import { posedSymbol } from "@/core/boneburst/boneburstPose";
import { AgentError, point, round, type PathKeyIn } from "./agentArgs";
import type { AgentApi } from "./AgentApi";
import { setKeys } from "./agentKeys";

/**
 * The AI's bone path tools (ARCHITECTURE ▸ Bone paths).
 */

export function pathOf(api: AgentApi, anim: Animation, node: Node, point: "tip" | "origin") {
  const { frames, closed } = pathFrames(anim);
  const p = api.store.project;
  return bonePaths({
    sample: (f) => posedSymbol(p, api.sym, anim, f, "animate"),
    ids: [node.id], frames, closed, which: point, isKey: keyedIn(anim),
  })[0]!;
}

export function getBonePath(api: AgentApi, animName: string, boneName: string, pointArg: unknown) {
  if (pointArg !== undefined && pointArg !== "tip" && pointArg !== "origin") throw new AgentError(`point is "tip" or "origin".`);
  const anim = api.animation(animName);
  const node = api.bone(boneName);
  const path = pathOf(api, anim, node, (pointArg as "tip" | "origin" | undefined) ?? "tip");
  return {
    animation: anim.name, bone: node.name, point: pointArg ?? "tip", closed: path.closed, fps: api.store.project.frameRate,
    // y up, as get_pose reports.
    points: path.points.map((q) => ({ frame: q.frame, x: round(q.x, 2), y: round(-q.y, 2), ...(q.key ? { key: true } : {}) })),
  };
}

export function setBonePath(api: AgentApi, animName: string, boneName: string, keys: PathKeyIn[]) {
  const anim = api.animation(animName);
  const node = api.bone(boneName);
  const rule = pathDragMode(api.sym, anim, node.id, "origin", false);
  if ("refused" in rule) throw new AgentError(rule.refused);
  if (rule.mode === "throughTarget") {
    const target = api.sym.nodes[api.sym.ik.find((k) => k.id === rule.ik.ik)!.targetId]!.name;
    throw new AgentError(`"${node.name}" is moved by IK: key its target "${target}" instead.`);
  }
  const pair = (v: unknown, where: string): { x: number; y: number } => {
    const [x, y] = point(v, where);
    return { x, y: -y };
  };
  for (const k of keys) {
    if (!Number.isInteger(k.frame) || k.frame < 0) throw new AgentError("Each key's frame is a whole number, 0 or more.");
    if (typeof k.x !== "number" || typeof k.y !== "number" || !Number.isFinite(k.x) || !Number.isFinite(k.y)) throw new AgentError(`Key at ${k.frame}: x and y are numbers.`);
  }
  const sorted = [...keys].sort((a, b) => a.frame - b.frame);
  if (new Set(sorted.map((k) => k.frame)).size !== sorted.length) throw new AgentError("Two keys at the same frame.");
  const label = `AI: Path of "${node.name}"`;
  const splits: number[] = [];
  let clamped = false;
  api.store.transaction(label, () => {
    setKeys(api, anim.name, sorted.map((k) => ({ bone: node.name, frame: k.frame, x: k.x, y: k.y })));
    let track = api.animation(animName).tracks[node.id]!;
    for (let i = 0; i + 1 < sorted.length; i++) {
      const a = sorted[i]!, b = sorted[i + 1]!;
      if (!a.out && !b.in) continue;
      const ka = track.keys[keyIndexAt(track, a.frame)]!;
      const kb = track.keys[keyIndexAt(track, a.frame) + 1]!;
      if (kb.frame !== b.frame) throw new AgentError(`"${node.name}" has a key at frame ${kb.frame}, between ${a.frame} and ${b.frame}: a handle bends one interval between two keys next to each other.`);
      const base: Spline = easesToSpline(ka, kb) ?? straightSpline(ka, kb);
      const s: Spline = {
        ...base,
        p1: a.out ? pair(a.out, `Key at ${a.frame}: out`) : base.p1,
        p2: b.in ? pair(b.in, `Key at ${b.frame}: in`) : base.p2,
      };
      const edit = withSpline(track, node, a.frame, s);
      if ("refused" in edit) throw new AgentError(`Between ${a.frame} and ${b.frame}: ${edit.refused}`);
      if (edit.split !== null) splits.push(edit.split);
      clamped ||= edit.clamped;
      track = edit.track;
    }
    api.commit(api.animation(animName), label, new Map([[node.id, track]]));
  });
  return {
    animation: anim.name, bone: node.name, keys: sorted.length,
    ...(splits.length ? { addedKeys: splits, note: "An axis that did not move between two keys had to bend: a key was added in the middle of that interval." } : {}),
    ...(clamped ? { clamped: "A handle was pulled in: that axis moves too little between its keys for the handle to reach so far." } : {}),
  };
}
