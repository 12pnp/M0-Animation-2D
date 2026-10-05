import { attachmentType } from "@/model/skeleton";
import type { Animation, Attachment, Skeleton, Skin, Slot } from "@/model/skeleton";
import { remapDrawOrder } from "./drawOrder";
import { EditRefused, type Edit } from "./history";

/**
 * Slot edits (Format-Json-Atlas.md §6). The slots' order is the setup draw order; every edit that
 * changes the list rewrites the animations' draw order keys to keep their meaning
 * (`edit/drawOrder.ts`).
 */

export const BLEND_MODES = ["normal", "additive", "multiply", "screen"] as const;

/** The fields of a slot an edit may set; `undefined` removes the key (the default then applies). */
export interface SlotPatch {
  bone?: string;
  color?: string | undefined;
  dark?: string | undefined;
  attachment?: string | undefined;
  blend?: string | undefined;
}

const HEX8 = /^[0-9a-f]{8}$/i, HEX6 = /^[0-9a-f]{6}$/i;

function slotNames(s: Skeleton): string[] { return (s.slots ?? []).map((x) => x.name); }

/** Every attachment in every skin, with where it is. */
function allAttachments(s: Skeleton): { skin: string; slot: string; key: string; a: Attachment }[] {
  return (s.skins ?? []).flatMap((sk) => (sk.attachments ?? []).flatMap((ss) => ss.entries.map((e) => ({ skin: sk.name, slot: ss.slot, key: e.key, a: e.attachment }))));
}

/** The skeleton with the slots changed to `next`, the draw order keys following (`rename`: old → new names). */
function withSlots(s: Skeleton, next: readonly Slot[], rename: ReadonlyMap<string, string> = new Map(), anims?: (a: Animation) => Animation): Skeleton {
  const from = slotNames(s), to = next.map((x) => x.name);
  const animations = s.animations?.map((a) => remapDrawOrder(anims ? anims(a) : a, from, to, rename));
  return { ...s, slots: next, ...(animations ? { animations } : {}) };
}

/** Add a slot on `bone`, at `at` in the draw order (default: on top, last). */
export function addSlot(name: string, bone: string, at?: number): Edit<Skeleton> {
  return (s) => {
    if (!name.trim()) throw new EditRefused("A slot needs a name.");
    if (s.slots?.some((x) => x.name === name)) throw new EditRefused(`There is already a slot "${name}".`);
    if (!s.bones?.some((b) => b.name === bone)) throw new EditRefused(`There is no bone "${bone}".`);
    const slots = [...(s.slots ?? [])];
    slots.splice(at ?? slots.length, 0, { name, bone, extra: new Map() });
    return withSlots(s, slots);
  };
}

/** Why `slot` cannot go: something outside it names it. */
export function slotUsers(s: Skeleton, slot: string): string | null {
  const path = s.constraints?.find((c) => c.type === "path" && c.slot === slot);
  if (path) return `the path constraint "${path.name}" follows it`;
  const clip = allAttachments(s).find(({ a }) => attachmentType(a) === "clipping" && a.end === slot);
  if (clip) return `the clipping "${clip.key}" in "${clip.slot}" ends at it`;
  const linked = allAttachments(s).find(({ slot: own, a }) => a.source !== undefined && own !== slot && a.slot === slot);
  if (linked) return `the linked mesh "${linked.key}" in "${linked.slot}" takes its source from it`;
  return null;
}

/** Remove slots and everything that lives in them: skin entries, timelines, draw order offsets. */
export function removeSlots(s: Skeleton, gone: ReadonlySet<string>): Skeleton {
  if (!gone.size) return s;
  const skins = s.skins?.map((sk): Skin => (sk.attachments ? { ...sk, attachments: sk.attachments.filter((ss) => !gone.has(ss.slot)) } : sk));
  const next = (s.slots ?? []).filter((x) => !gone.has(x.name));
  const out = withSlots(s, next, new Map(), (a) => {
    let r: Animation = a;
    if (a.slots) r = { ...r, slots: a.slots.filter((g) => !gone.has(g.name)) };
    if (a.attachments) r = { ...r, attachments: a.attachments.map((st) => ({ ...st, slots: st.slots.filter((x) => !gone.has(x.slot)) })).filter((st) => st.slots.length) };
    return r;
  });
  return { ...out, ...(skins ? { skins } : {}) };
}

/** Delete a slot. Refused while a path constraint, a clipping or a linked mesh elsewhere names it. */
export function deleteSlot(name: string): Edit<Skeleton> {
  return (s) => {
    if (!s.slots?.some((x) => x.name === name)) throw new EditRefused(`There is no slot "${name}".`);
    const why = slotUsers(s, name);
    if (why) throw new EditRefused(`"${name}" cannot be deleted: ${why}.`);
    return removeSlots(s, new Set([name]));
  };
}

/** Rename a slot, and every reference to it. */
export function renameSlot(from: string, to: string): Edit<Skeleton> {
  return (s) => {
    if (from === to) return s;
    if (!s.slots?.some((x) => x.name === from)) throw new EditRefused(`There is no slot "${from}".`);
    if (!to.trim()) throw new EditRefused("A slot needs a name.");
    if (s.slots.some((x) => x.name === to)) throw new EditRefused(`There is already a slot "${to}".`);
    const r = (n: string) => (n === from ? to : n);
    const att = (a: Attachment): Attachment => {
      let out = a;
      if (a.end === from) out = { ...out, end: to };
      if (a.slot === from) out = { ...out, slot: to };
      return out;
    };
    const skins = s.skins?.map((sk): Skin => (sk.attachments
      ? { ...sk, attachments: sk.attachments.map((ss) => ({ ...ss, slot: r(ss.slot), entries: ss.entries.map((e) => ({ ...e, attachment: att(e.attachment) })) })) }
      : sk));
    const constraints = s.constraints?.map((c) => (c.type === "path" && c.slot === from ? { ...c, slot: to } : c));
    const out = withSlots(s, s.slots.map((x) => (x.name === from ? { ...x, name: to } : x)), new Map([[from, to]]), (a) => {
      let x: Animation = a;
      if (a.slots) x = { ...x, slots: a.slots.map((g) => (g.name === from ? { ...g, name: to } : g)) };
      if (a.attachments) x = { ...x, attachments: a.attachments.map((st) => ({ ...st, slots: st.slots.map((sl) => (sl.slot === from ? { ...sl, slot: to } : sl)) })) };
      return x;
    });
    return { ...out, ...(skins ? { skins } : {}), ...(constraints ? { constraints } : {}) };
  };
}

/** Set fields of a slot. The bone must exist; the setup attachment must be one the slot has in a skin. */
export function updateSlot(name: string, patch: SlotPatch): Edit<Skeleton> {
  return (s) => {
    const slots = s.slots ?? [];
    const i = slots.findIndex((x) => x.name === name);
    if (i < 0) throw new EditRefused(`There is no slot "${name}".`);
    if (patch.bone !== undefined && !s.bones?.some((b) => b.name === patch.bone)) throw new EditRefused(`There is no bone "${patch.bone}".`);
    if (patch.color !== undefined && !HEX8.test(patch.color)) throw new EditRefused("A slot colour is 8 hex digits, rrggbbaa.");
    if (patch.dark !== undefined && !HEX6.test(patch.dark)) throw new EditRefused("A dark colour is 6 hex digits, rrggbb.");
    if (patch.blend !== undefined && !(BLEND_MODES as readonly string[]).includes(patch.blend)) throw new EditRefused(`A blend mode is one of ${BLEND_MODES.join(", ")}.`);
    if (patch.attachment !== undefined && !allAttachments(s).some((x) => x.slot === name && x.key === patch.attachment)) {
      throw new EditRefused(`"${name}" has no attachment "${patch.attachment}" in any skin.`);
    }
    const next: Record<string, unknown> = { ...slots[i]! };
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (next[k] === v) continue;
      changed = true;
      if (v === undefined) delete next[k]; else next[k] = v;
    }
    if (!changed) return s;
    return { ...s, slots: slots.map((x, n) => (n === i ? (next as unknown as Slot) : x)) };
  };
}

/** Move a slot to `to` in the setup draw order (0 is drawn first, at the back). */
export function moveSlot(name: string, to: number): Edit<Skeleton> {
  return (s) => {
    const slots = [...(s.slots ?? [])];
    const i = slots.findIndex((x) => x.name === name);
    if (i < 0) throw new EditRefused(`There is no slot "${name}".`);
    const at = Math.max(0, Math.min(slots.length - 1, to));
    if (at === i) return s;
    const [slot] = slots.splice(i, 1);
    slots.splice(at, 0, slot!);
    return withSlots(s, slots);
  };
}
