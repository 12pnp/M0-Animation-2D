import { addAttachment, addRegion, type AttachmentRef } from "@/edit/attachments";
import { addBone } from "@/edit/bones";
import { newPointAttachment, newPolygon } from "@/edit/create";
import { EditRefused } from "@/edit/history";
import { toLocal } from "@/edit/meshLayout";
import { addSlot, updateSlot } from "@/edit/slots";
import { uniqueName } from "../names";
import type { Session } from "../session";
import type { Point } from "./gizmo";

/** What the Create group makes (docs/STAGE-POSE-PLAN.md step 2; Region, from the loaded atlas, since the owner chose it). */
export type CreateKind = "bone" | "region" | "point" | "boundingbox" | "clipping" | "path";

/** A press shorter than this many screen pixels is a click, not a drag. */
export const CLICK_PX = 4;
/** A click's bone is this long, and its box this wide. */
const DEFAULT_LENGTH = 50;
const DEFAULT_BOX = 100;

/**
 * A new bone under `parent` (null only for the first bone of an empty skeleton), from `from` to
 * `to` in the world: it starts at `from`, points at `to` and is as long as the way between them; a
 * click (`to` null) makes the default one, pointing along its parent. One undo step; it is
 * selected, so the next press carries on the chain under it. Returns what to tell the person.
 */
export function createBone(session: Session, parent: string | null, from: Point, to: Point | null): string {
  const doc = session.doc, h = session.history, setup = session.setupBones();
  if (!doc || !h) return "Open a skeleton first.";
  const bones = doc.bones ?? [];
  const name = uniqueName("bone", bones.map((b) => b.name));
  const pi = parent === null ? -1 : bones.findIndex((b) => b.name === parent);
  const pm = pi >= 0 ? setup?.[pi] : undefined;
  const [x, y] = pm ? toLocal(pm, from[0], from[1]) : from;
  let length = DEFAULT_LENGTH, rotation = 0;
  if (to) {
    length = Math.round(Math.hypot(to[0] - from[0], to[1] - from[1]) * 100) / 100;
    const world = (Math.atan2(to[1] - from[1], to[0] - from[0]) * 180) / Math.PI;
    const parentTurn = pm ? (Math.atan2(pm[2]!, pm[0]!) * 180) / Math.PI : 0;
    rotation = Math.round((((world - parentTurn + 540) % 360) - 180) * 100) / 100;
  }
  const patch = { x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, length, ...(rotation ? { rotation } : {}) };
  try {
    if (!h.apply(`Add bone ${name}`, addBone(name, parent, patch))) return "Nothing was added.";
  } catch (err) {
    if (!(err instanceof EditRefused)) throw err;
    return err.message;
  }
  session.changed();
  session.select({ kind: "bone", name });
  return `Added ${name}${parent ? ` under ${parent}` : ""}: press again to carry on from it.`;
}

/**
 * A point, a bounding box or a clipping polygon on a new slot of `bone`, in one undo step. A box
 * and a clipping polygon are the rectangle with opposite corners `a` and `b` (world), or, for a
 * click, 100 units wide round `a`. A clipping polygon clips every slot from its own to the last.
 */
export function createShape(session: Session, kind: "point" | "boundingbox" | "clipping", bone: string, a: Point, b: Point | null): string {
  const doc = session.doc, h = session.history, setup = session.setupBones();
  if (!doc || !h) return "Open a skeleton first.";
  const i = (doc.bones ?? []).findIndex((x) => x.name === bone), m = setup?.[i];
  if (!m) return `${bone} has no pose to place it by.`;
  const local = (p: Point): [number, number] => toLocal(m, p[0], p[1]);
  const slots = doc.slots ?? [], slot = uniqueName(`${bone}-${kind}`, slots.map((x) => x.name));
  const keys = (doc.skins?.find((k) => k.name === "default")?.attachments?.find((x) => x.slot === slot)?.entries ?? []).map((e) => e.key);
  const ref: AttachmentRef = { skin: "default", slot, key: uniqueName(kind, keys) };
  let attachment;
  if (kind === "point") attachment = newPointAttachment(...local(a));
  else {
    const half = DEFAULT_BOX / 2;
    const p0: Point = b && Math.hypot(b[0] - a[0], b[1] - a[1]) > 1 ? a : [a[0] - half, a[1] - half], p1: Point = b && Math.hypot(b[0] - a[0], b[1] - a[1]) > 1 ? b : [a[0] + half, a[1] + half];
    const corners = [local([p0[0], p0[1]]), local([p1[0], p0[1]]), local([p1[0], p1[1]]), local([p0[0], p1[1]])];
    // The clipping slot goes first, so it cuts every slot after it up to the last.
    attachment = newPolygon(kind, corners, kind === "clipping" ? slots[slots.length - 1]?.name ?? slot : undefined);
  }
  h.begin(`Add ${kind} ${ref.key} on ${bone}`);
  try {
    h.apply("step", addSlot(slot, bone, kind === "clipping" ? 0 : undefined));
    h.apply("step", addAttachment(ref, attachment));
    // The slot shows it from the setup pose on, so it is drawn.
    h.apply("step", updateSlot(slot, { attachment: ref.key }));
  } catch (err) {
    h.cancel();
    if (!(err instanceof EditRefused)) throw err;
    return err.message;
  }
  h.end();
  session.changed();
  session.select({ kind: "attachment", skin: ref.skin, slot: ref.slot, key: ref.key });
  return kind === "clipping" ? `Added ${ref.key}: it clips every slot after it.` : `Added ${ref.key} on ${bone}.`;
}

/**
 * A region attachment of the atlas region `region` on a new slot of `bone`, centred on `at` (world),
 * as large as the region's original size, in one undo step; the slot shows it and it is selected.
 */
export function createRegion(session: Session, region: string, bone: string, at: Point): string {
  const doc = session.doc, h = session.history, setup = session.setupBones();
  if (!doc || !h) return "Open a skeleton first.";
  const img = session.images.regions.find((r) => r.name === region);
  if (!img) return `The atlas has no region "${region}".`;
  const i = (doc.bones ?? []).findIndex((x) => x.name === bone), m = setup?.[i];
  if (!m) return `${bone} has no pose to place it by.`;
  const [x, y] = toLocal(m, at[0], at[1]);
  const slot = uniqueName(region, (doc.slots ?? []).map((v) => v.name));
  const skin = session.skin ?? "default", ref: AttachmentRef = { skin, slot, key: region };
  h.begin(`Add region ${region} on ${bone}`);
  try {
    h.apply("step", addSlot(slot, bone));
    h.apply("step", addRegion(ref, { width: img.originalWidth, height: img.originalHeight, ...(Math.abs(x) > 0.005 ? { x: Math.round(x * 100) / 100 } : {}), ...(Math.abs(y) > 0.005 ? { y: Math.round(y * 100) / 100 } : {}) }));
    h.apply("step", updateSlot(slot, { attachment: ref.key }));
  } catch (err) {
    h.cancel();
    if (!(err instanceof EditRefused)) throw err;
    return err.message;
  }
  h.end();
  session.changed();
  session.select({ kind: "attachment", skin: ref.skin, slot: ref.slot, key: ref.key });
  return `Added ${region} on ${bone}.`;
}
