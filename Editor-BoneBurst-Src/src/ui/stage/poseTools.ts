import { type AttachmentRef, findAttachment } from "@/edit/attachments";
import { updateBone } from "@/edit/bones";
import { EditRefused } from "@/edit/history";
import { regionToMesh } from "@/edit/mesh";
import { attachmentType } from "@/model/skeleton";
import type { Session } from "../session";
import { brush } from "./weightBrush";

/**
 * The Pose-mode tools the Stage offers beside the panels' own buttons (docs/STAGE-POSE-PLAN.md step
 * 4): each does what the matching button in Properties does, from where the person is working. Each
 * returns what to tell them.
 */

/** The attachment the selection means: the selected one, or the one the selected slot shows. */
function shownRef(session: Session): AttachmentRef | null {
  const doc = session.doc, sel = session.selected;
  if (!doc) return null;
  if (sel?.kind === "attachment") return { skin: sel.skin, slot: sel.slot, key: sel.key };
  if (sel?.kind !== "slot") return null;
  const key = doc.slots?.find((x) => x.name === sel.name)?.attachment;
  if (!key) return null;
  for (const skin of [session.skin, "default"]) if (skin && findAttachment(doc, { skin, slot: sel.name, key })) return { skin, slot: sel.name, key };
  return null;
}

/** Edit the mesh of the selected slot's image: a region is made a mesh first (one undo step). */
export function editMesh(session: Session): string {
  const ref = shownRef(session), doc = session.doc, h = session.history;
  if (!ref || !doc || !h) return "Select an image (a press on it, with Select ▸ Images on) or its slot first.";
  const a = findAttachment(doc, ref);
  if (!a) return "That image has no attachment to edit.";
  const type = attachmentType(a);
  if (type === "region") {
    try { h.apply(`Convert ${ref.key} to a mesh`, regionToMesh(ref)); } catch (err) {
      if (!(err instanceof EditRefused)) throw err;
      return err.message;
    }
    session.changed();
  } else if (type !== "mesh") return `A ${type} has no mesh to edit.`;
  session.select({ kind: "attachment", ...ref });
  return `Editing the mesh of ${ref.key}: drag its vertices on the stage.`;
}

/** The weight brush on or off (Properties ▸ Paint weights), for the mesh being edited. */
export function togglePaint(session: Session): string {
  const doc = session.doc, sel = session.selected;
  const a = doc && sel?.kind === "attachment" ? findAttachment(doc, sel) : undefined;
  if (!brush.on && (!a || attachmentType(a) !== "mesh")) return "Edit a mesh first (the Mesh tool), then paint its weights.";
  brush.on = !brush.on;
  session.changed();
  if (!brush.on) return "Weight brush off.";
  return session.weightBone ? `Paint ${session.weightBone}'s weights: drag on the stage (Alt takes away; [ and ] size the brush).` : "Choose the bone to paint in Properties ▸ Show weights.";
}

/** Select the path of the selected slot or bone (its first), to edit its points on the stage. */
export function editPath(session: Session): string {
  const doc = session.doc, sel = session.selected;
  if (!doc) return "Open a skeleton first.";
  const slots = (doc.slots ?? []).filter((x) => (sel?.kind === "slot" ? x.name === sel.name : sel?.kind === "bone" ? x.bone === sel.name : sel?.kind === "attachment" ? x.name === sel.slot : false));
  for (const slot of slots) {
    for (const skin of doc.skins ?? []) {
      const entry = skin.attachments?.find((x) => x.slot === slot.name)?.entries.find((e) => attachmentType(e.attachment) === "path");
      if (entry) { session.select({ kind: "attachment", skin: skin.name, slot: slot.name, key: entry.key }); return `Editing the path ${entry.key}: drag its points on the stage.`; }
    }
  }
  return "Select a bone or slot that has a path (Create ▸ Path makes one).";
}

/**
 * The selected bone's rotation, scale and shear back to the defaults (0, 1, 0), as the right-click menu does:
 * in Pose mode these are the rig's own values, so it is only ever the one bone, and one undo step.
 */
export function resetPose(session: Session): string {
  const doc = session.doc, h = session.history, name = session.selectedBone;
  if (!doc || !h) return "Open a skeleton first.";
  if (name === null) return "Select a bone to reset.";
  try {
    h.apply(`Reset the rotation, scale and shear of bone ${name}`, updateBone(name, { rotation: undefined, scaleX: undefined, scaleY: undefined, shearX: undefined, shearY: undefined }));
  } catch (err) {
    if (!(err instanceof EditRefused)) throw err;
    return err.message;
  }
  session.changed();
  return `Reset ${name}'s rotation, scale and shear.`;
}
