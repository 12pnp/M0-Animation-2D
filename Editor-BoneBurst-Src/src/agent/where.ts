import type { AttachmentRef } from "@/edit/attachments";
import type { Attachment, Skeleton, Slot } from "@/model/skeleton";
import { type AgentContext, AgentRefused } from "./context";

/**
 * Finding what the step-8 tools name (E5-PLAN step 8): a slot (`layer`), its displays (the keys
 * it has across the skins, the default skin's first, in document order), the attachment a display
 * shows, and the attachments showing an atlas image.
 */

export function slotNamed(doc: Skeleton, name: unknown): Slot {
  const s = doc.slots?.find((x) => x.name === name);
  if (!s) throw new AgentRefused(`There is no slot "${String(name)}"; get_rig lists the slots.`);
  return s;
}

/** The slot's attachment keys: the default skin's, then those only other skins have. */
export function displaysOf(doc: Skeleton, slot: string): string[] {
  const keys: string[] = [];
  const skins = [...(doc.skins ?? [])].sort((a, b) => (a.name === "default" ? -1 : b.name === "default" ? 1 : 0));
  for (const k of skins) for (const ss of k.attachments ?? []) if (ss.slot === slot) for (const e of ss.entries) if (!keys.includes(e.key)) keys.push(e.key);
  return keys;
}

/** The key of display `display` (default 0) of the slot. */
export function displayKey(doc: Skeleton, slot: string, display: unknown): string {
  const keys = displaysOf(doc, slot), i = (display as number | undefined) ?? 0;
  if (!keys.length) throw new AgentRefused(`The slot "${slot}" has no images.`);
  if (i >= keys.length) throw new AgentRefused(`The slot "${slot}" has ${keys.length} display${keys.length === 1 ? "" : "s"} (${keys.join(", ")}); display ${i} is not one.`);
  return keys[i]!;
}

/** The attachment stored under `key` for the slot in `skin`, or undefined. */
export function entryOf(doc: Skeleton, skin: string, slot: string, key: string): Attachment | undefined {
  return doc.skins?.find((k) => k.name === skin)?.attachments?.find((ss) => ss.slot === slot)?.entries.find((e) => e.key === key)?.attachment;
}

/** Where the attachment the editor shows for `key` is: the shown skin's when it has one, else the default skin's, else any skin's. */
export function shownEntry(doc: Skeleton, ctx: AgentContext, slot: string, key: string): AttachmentRef {
  const order = [ctx.view().skin, "default", ...(doc.skins ?? []).map((k) => k.name)].filter((n): n is string => !!n);
  for (const skin of order) if (entryOf(doc, skin, slot, key)) return { skin, slot, key };
  throw new AgentRefused(`The slot "${slot}" has no attachment "${key}".`);
}

/** The atlas image an attachment shows (a sequence's: its path, the prefix). */
export const imageOf = (a: Attachment, key: string): string => a.path ?? a.name ?? key;

/** Every attachment showing atlas image `image`, in any skin. */
export function showing(doc: Skeleton, image: string): AttachmentRef[] {
  const out: AttachmentRef[] = [];
  for (const k of doc.skins ?? []) for (const ss of k.attachments ?? []) for (const e of ss.entries) {
    if (imageOf(e.attachment, e.key) === image) out.push({ skin: k.name, slot: ss.slot, key: e.key });
  }
  return out;
}

/** "rrggbb" or "rrggbbaa" as Spine's rrggbbaa; null as undefined, and opaque white too when it means no colour (a tint). */
export function colourOf(c: unknown, whiteIsNone = true): string | undefined {
  if (c === null) return undefined;
  const s = String(c).toLowerCase();
  if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(s)) throw new AgentRefused(`"${String(c)}" is not a colour: give "rrggbb" or "rrggbbaa" in hex.`);
  const full = s.length === 6 ? `${s}ff` : s;
  return whiteIsNone && full === "ffffffff" ? undefined : full;
}
