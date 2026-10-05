import { addBone } from "@/edit/bones";
import { addConstraint, type ConstraintRef, TRANSFORM_PROPERTIES } from "@/edit/constraints";
import { EditRefused, type Edit } from "@/edit/history";
import type { AtlasImages } from "@/engine/regions";
import { attachmentType, type Constraint, type ConstraintType, type Skeleton } from "@/model/skeleton";
import { boneTip, localPoint, poseSetup } from "../stage/posed";
import { unique } from "./outline";

/** What a new constraint starts from: the selected bone or slot, the skin and animation shown. */
export interface NewFrom {
  readonly bone: string | null;
  readonly slot: string | null;
  readonly skin: string | null;
  readonly animation: string | null;
}

/**
 * The edit that adds a new constraint of kind `type` from the selection, and the constraint it
 * selects (E4-PLAN step 4): it leaves the pose as it was. An IK aims the bone at a new target
 * bone at its tip; a transform and a slider start with every mix at 0; a path follows the slot
 * with no bones yet; physics feeds in rotation, which moves only in playback. Refused, with what
 * to select, when the selection does not fit the kind.
 */
export function newConstraint(doc: Skeleton, images: AtlasImages, type: ConstraintType, from: NewFrom): { edit: Edit<Skeleton>; ref: ConstraintRef } {
  const taken = (doc.constraints ?? []).filter((c) => c.type === type).map((c) => c.name);
  const named = (base: string) => unique(`${base}-${type}`, taken);
  const bones = doc.bones ?? [];
  const needBone = () => {
    if (!from.bone) throw new EditRefused(`Select the bone the ${type} constraint moves.`);
    return from.bone;
  };
  let c: Constraint;
  const pre: Edit<Skeleton>[] = [];
  switch (type) {
    case "ik": {
      const bone = needBone(), root = bones.find((b) => b.parent === undefined)!.name;
      if (bone === root) throw new EditRefused("The root bone cannot be bent by IK; select a bone under it.");
      // A new target at the bone's tip, under the root: the bone already points at it. Four
      // decimals, so the aim does not shift the bones under it (two moved hero-pro's head 0.006).
      const p = poseSetup(doc, images, from.skin), i = p.bones.get(bone)!, [tx, ty] = boneTip(p, i);
      const target = unique(`${bone}-target`, bones.map((b) => b.name));
      const at = localPoint(p, p.bones.get(root)!, tx, ty, 4);
      pre.push(addBone(target, root, { ...(at.x ? { x: at.x } : {}), ...(at.y ? { y: at.y } : {}) }));
      c = { type, name: named(bone), bones: [bone], target, extra: new Map() };
      break;
    }
    case "transform": {
      const bone = needBone(), parent = bones.find((b) => b.name === bone)?.parent;
      if (parent === undefined) throw new EditRefused("The root bone has no parent to follow; select a bone under it.");
      // Each property to itself, every mix 0: nothing moves until a mix is raised.
      c = {
        type, name: named(bone), bones: [bone], source: parent,
        properties: TRANSFORM_PROPERTIES.map((p) => ({ from: p, to: [{ to: p, extra: new Map() }], extra: new Map() })),
        mixRotate: 0, mixX: 0, mixY: 0, mixScaleX: 0, mixScaleY: 0, mixShearY: 0, extra: new Map(),
      };
      break;
    }
    case "path": {
      const slot = from.slot;
      if (!slot) throw new EditRefused("Select the slot holding the path the constraint follows.");
      const hasPath = (doc.skins ?? []).some((k) => k.attachments?.find((ss) => ss.slot === slot)?.entries.some((e) => attachmentType(e.attachment) === "path"));
      if (!hasPath) throw new EditRefused(`"${slot}" holds no path attachment for the constraint to follow.`);
      c = { type, name: named(slot), slot, extra: new Map() };
      break;
    }
    case "physics": {
      const bone = needBone();
      c = { type, name: named(bone), bone, rotate: 1, extra: new Map() };
      break;
    }
    case "slider": {
      const animation = from.animation ?? doc.animations?.[0]?.name;
      if (!animation) throw new EditRefused("A slider plays an animation; add one first.");
      c = { type, name: named(animation), animation, mix: 0, extra: new Map() };
      break;
    }
  }
  const made = c;
  return { edit: (d) => addConstraint(made)(pre.reduce((acc, e) => e(acc), d)), ref: { type, name: made.name } };
}
