import { addAttachment, type AttachmentRef, findAttachment } from "@/edit/attachments";
import { EditRefused } from "@/edit/history";
import { toLocal } from "@/edit/meshLayout";
import { newPathAttachment } from "@/edit/path";
import { addSlot } from "@/edit/slots";
import type { Session } from "../session";
import { uniqueName } from "../names";
import type { Point } from "./gizmo";

/**
 * Make a path attachment (docs/PATH-PLAN.md): on `target.slot`, or, given a bone, on a new slot of
 * that bone (one undo step for both). It starts as two points 100 units apart, at the world point
 * `at` when one is given (the right-click menu), else at the slot bone's origin. It is selected
 * after, ready to drag. Returns what to tell the person.
 */
export function createPath(session: Session, target: { slot?: string; bone?: string }, at?: Point): string {
  const doc = session.doc, h = session.history;
  if (!doc || !h) return "Open a skeleton first.";
  const slotName = target.slot ?? (target.bone ? uniqueName(`${target.bone}-path`, (doc.slots ?? []).map((x) => x.name)) : null);
  const boneName = target.slot ? doc.slots?.find((x) => x.name === target.slot)?.bone : target.bone;
  if (!slotName || boneName === undefined) return "Select a slot or a bone to put the path on.";
  const keys = (doc.skins?.find((k) => k.name === "default")?.attachments?.find((a) => a.slot === slotName)?.entries ?? []).map((e) => e.key);
  const ref: AttachmentRef = { skin: "default", slot: slotName, key: uniqueName("path", keys) };
  let start: Point = [0, 0];
  if (at) {
    const bones = session.setupBones(), i = (doc.bones ?? []).findIndex((b) => b.name === boneName);
    if (bones?.[i]) start = toLocal(bones[i]!, at[0], at[1]);
  }
  h.begin(target.slot ? `Add path ${ref.key} to ${slotName}` : `Add path ${ref.key} on ${boneName}`);
  try {
    if (!target.slot) h.apply("step", addSlot(slotName, boneName));
    h.apply("step", addAttachment(ref, newPathAttachment(start[0], start[1])));
  } catch (err) {
    h.cancel();
    if (!(err instanceof EditRefused)) throw err;
    return err.message;
  }
  h.end();
  session.changed();
  if (findAttachment(session.doc!, ref)) {
    session.select({ kind: "attachment", skin: ref.skin, slot: ref.slot, key: ref.key });
    session.pathVertex = 4;
  }
  return `Added the path ${ref.key} on ${slotName}: drag its points, or type them in the path window.`;
}
