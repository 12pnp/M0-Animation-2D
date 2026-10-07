import { subtree, updateBone } from "@/edit/bones";
import type { Edit } from "@/edit/history";
import { localFromWorld } from "@/engine/bones";
import { BONE_DEFAULTS, boneInherit } from "@/model/defaults";
import type { Skeleton } from "@/model/skeleton";
import type { Session } from "./session";
import { tidy } from "./stage/gizmo";
import { Poser } from "./stage/posed";

/**
 * Bone options (docs/STAGE-POSE-PLAN.md step 3): an edit of a bone's own values in the setup pose, with
 * the bones that should stay put put back. With Compensate on, that is every child of the bone; a
 * pinned bone under it stays too, at any depth. Each is given the local values that leave its world
 * place as it was under the bone's new place. Bones that do not inherit normally are left as the
 * edit leaves them, and nothing changes while an animation is shown (its keys own the values).
 */
export function compensated(session: Session, name: string, edit: Edit<Skeleton>): Edit<Skeleton> {
  if (session.animation || (!session.compensate && session.pinned.size === 0)) return edit;
  return (s) => {
    const after = edit(s), bones = s.bones ?? [], under = new Set(subtree(s, name));
    const hold = bones.filter((b) => b.name !== name && under.has(b.name) && ((session.compensate && b.parent === name) || session.pinned.has(b.name)));
    if (!hold.length) return after;
    const before = new Poser(s, session.images).pose(session.skin, null, 0);
    let out = after, now = new Poser(after, session.images).pose(session.skin, null, 0);
    for (const b of hold) {
      if (boneInherit(b) !== "normal" || b.parent === undefined) continue;
      const i = before.bones.get(b.name), pi = now.bones.get(b.parent);
      if (i === undefined || pi === undefined) continue;
      const W = before.rig.world, P = now.rig.world, q = pi * 6, v = new Float64Array(7);
      localFromWorld(W, i * 6, P[q]!, P[q + 1]!, P[q + 2]!, P[q + 3]!, P[q + 4]!, P[q + 5]!, v, 0);
      const values = { x: tidy(v[0]!, 2), y: tidy(v[1]!, 2), rotation: tidy(v[2]!, 2), scaleX: tidy(v[3]!, 4), scaleY: tidy(v[4]!, 4), shearX: tidy(v[5]!, 2), shearY: tidy(v[6]!, 2) };
      const patch: Record<string, number | undefined> = {};
      for (const [k, n] of Object.entries(values) as [keyof typeof values, number][]) patch[k] = n === BONE_DEFAULTS[k] ? undefined : n;
      out = updateBone(b.name, patch)(out);
      // A held bone may be the parent of the next: measure from where it is now.
      if (hold.length > 1) now = new Poser(out, session.images).pose(session.skin, null, 0);
    }
    return out;
  };
}
