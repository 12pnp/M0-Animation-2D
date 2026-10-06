import type { Animation, Attachment, Skeleton, Skin, SkinSlot } from "@/model/skeleton";
import { EditRefused, type Edit } from "./history";
import { refuseNonFinite } from "./finite";

/**
 * Attachment edits (Format-Json-Atlas.md §8). An attachment is stored in a skin, under a slot,
 * by its key (the placeholder name). Its image is found by `path`, else `name`, else the key.
 */

export interface AttachmentRef { readonly skin: string; readonly slot: string; readonly key: string }

/** The fields an edit may set on an attachment; `undefined` removes the key. */
export type AttachmentPatch = { -readonly [K in Exclude<keyof Attachment, "extra" | "type" | "sequence">]?: Attachment[K] | undefined };

export function findAttachment(s: Skeleton, r: AttachmentRef): Attachment | undefined {
  return s.skins?.find((k) => k.name === r.skin)?.attachments?.find((a) => a.slot === r.slot)?.entries.find((e) => e.key === r.key)?.attachment;
}

/** `s` with the skin's slot entries changed by `f` (null: no change); emptied slots are dropped. */
function onSkinSlot(s: Skeleton, skin: string, slot: string, f: (entries: SkinSlot["entries"]) => SkinSlot["entries"] | null): Skeleton {
  const skins = s.skins ?? [];
  const i = skins.findIndex((k) => k.name === skin);
  if (i < 0) throw new EditRefused(`There is no skin "${skin}".`);
  const sk = skins[i]!;
  const slots = sk.attachments ?? [];
  const j = slots.findIndex((x) => x.slot === slot);
  const entries = f(j < 0 ? [] : slots[j]!.entries);
  if (!entries) return s;
  const next: SkinSlot[] = j < 0 ? [...slots, { slot, entries }] : slots.map((x, n) => (n === j ? { ...x, entries } : x));
  const kept = next.filter((x) => x.entries.length);
  const skinNext: Skin = { ...sk, attachments: kept };
  return { ...s, skins: skins.map((k, n) => (n === i ? skinNext : k)) };
}

/** Add a region attachment. The default skin is created when the skeleton has none yet. */
export function addRegion(r: AttachmentRef, fields: AttachmentPatch & { width: number; height: number }): Edit<Skeleton> {
  return (s0) => {
    refuseNonFinite(`Attachment "${r.key}"`, fields);
    if (!r.key.trim()) throw new EditRefused("An attachment needs a name.");
    if (!s0.slots?.some((x) => x.name === r.slot)) throw new EditRefused(`There is no slot "${r.slot}".`);
    if (!(fields.width > 0 && fields.height > 0)) throw new EditRefused("A region needs a width and a height above 0.");
    let s = s0;
    if (!s.skins?.some((k) => k.name === r.skin)) {
      if (r.skin !== "default") throw new EditRefused(`There is no skin "${r.skin}".`);
      s = { ...s, skins: [{ name: "default", attachments: [], extra: new Map() }, ...(s.skins ?? [])] };
    }
    if (findAttachment(s, r)) throw new EditRefused(`"${r.slot}" already has an attachment "${r.key}" in "${r.skin}".`);
    const a = { ...stripUndefined(fields), extra: new Map() } as Attachment;
    return onSkinSlot(s, r.skin, r.slot, (entries) => [...entries, { key: r.key, attachment: a }]);
  };
}

/** Add any attachment as it is given (a box, a point, a path: E5 step 5); the default skin is created when missing. */
export function addAttachment(r: AttachmentRef, a: Attachment): Edit<Skeleton> {
  return (s0) => {
    refuseNonFinite(`Attachment "${r.key}"`, a);
    if (!r.key.trim()) throw new EditRefused("An attachment needs a name.");
    if (!s0.slots?.some((x) => x.name === r.slot)) throw new EditRefused(`There is no slot "${r.slot}".`);
    let s = s0;
    if (!s.skins?.some((k) => k.name === r.skin)) {
      if (r.skin !== "default") throw new EditRefused(`There is no skin "${r.skin}".`);
      s = { ...s, skins: [{ name: "default", attachments: [], extra: new Map() }, ...(s.skins ?? [])] };
    }
    if (findAttachment(s, r)) throw new EditRefused(`"${r.slot}" already has an attachment "${r.key}" in "${r.skin}".`);
    return onSkinSlot(s, r.skin, r.slot, (entries) => [...entries, { key: r.key, attachment: a }]);
  };
}

/** Linked meshes that take `r` as their source. */
function linkedTo(s: Skeleton, r: AttachmentRef): string[] {
  const out: string[] = [];
  for (const sk of s.skins ?? []) for (const ss of sk.attachments ?? []) for (const e of ss.entries) {
    const a = e.attachment;
    if (a.source === r.key && (a.slot ?? ss.slot) === r.slot && (a.skin ?? "default") === r.skin) out.push(`${sk.name}/${ss.slot}/${e.key}`);
  }
  return out;
}

/** The animation without the deform and sequence timelines of `r`. */
function withoutTimelines(a: Animation, r: AttachmentRef): Animation {
  if (!a.attachments) return a;
  const attachments = a.attachments
    .map((st) => (st.skin !== r.skin ? st : {
      ...st, slots: st.slots
        .map((sl) => (sl.slot !== r.slot ? sl : { ...sl, attachments: sl.attachments.filter((g) => g.name !== r.key) }))
        .filter((sl) => sl.attachments.length),
    }))
    .filter((st) => st.slots.length);
  if (attachments.length) return { ...a, attachments };
  const { attachments: _, ...rest } = a;
  return rest as Animation;
}

/** Delete an attachment and its deform and sequence timelines. Refused while a linked mesh uses it. */
export function deleteAttachment(r: AttachmentRef): Edit<Skeleton> {
  return (s) => {
    if (!findAttachment(s, r)) throw new EditRefused(`There is no attachment "${r.key}" in "${r.slot}" of "${r.skin}".`);
    const linked = linkedTo(s, r);
    if (linked.length) throw new EditRefused(`"${r.key}" is the source of the linked mesh ${linked[0]}.`);
    let out = onSkinSlot(s, r.skin, r.slot, (entries) => entries.filter((e) => e.key !== r.key));
    if (out.animations) out = { ...out, animations: out.animations.map((a) => withoutTimelines(a, r)) };
    // A setup attachment no skin has any more shows nothing: the slot shows nothing.
    const stillThere = out.skins?.some((k) => k.attachments?.some((ss) => ss.slot === r.slot && ss.entries.some((e) => e.key === r.key)));
    if (!stillThere && out.slots?.some((x) => x.name === r.slot && x.attachment === r.key)) {
      out = { ...out, slots: out.slots.map((x) => { if (x.name !== r.slot || x.attachment !== r.key) return x; const { attachment: _, ...rest } = x; return rest; }) };
    }
    return out;
  };
}

/**
 * Rename an attachment's key in every skin that has it for that slot, and every reference: the
 * slot's setup attachment, attachment keys, deform and sequence timelines, linked meshes. Its
 * image stays: a key that was also its path gets the old one as `path`.
 */
export function renameAttachment(r: AttachmentRef, to: string): Edit<Skeleton> {
  return (s) => {
    if (r.key === to) return s;
    if (!findAttachment(s, r)) throw new EditRefused(`There is no attachment "${r.key}" in "${r.slot}" of "${r.skin}".`);
    if (!to.trim()) throw new EditRefused("An attachment needs a name.");
    const has = (k: string) => s.skins?.some((sk) => sk.attachments?.some((ss) => ss.slot === r.slot && ss.entries.some((e) => e.key === k)));
    if (has(to)) throw new EditRefused(`"${r.slot}" already has an attachment "${to}".`);
    const skins = s.skins?.map((sk): Skin => (!sk.attachments ? sk : {
      ...sk, attachments: sk.attachments.map((ss) => ({
        ...ss, entries: ss.entries.map((e) => {
          let a = e.attachment;
          if (a.source === r.key && (a.slot ?? ss.slot) === r.slot) a = { ...a, source: to };
          if (ss.slot !== r.slot || e.key !== r.key) return a === e.attachment ? e : { ...e, attachment: a };
          if (a.path === undefined && a.name === undefined) a = { ...a, path: r.key };
          return { key: to, attachment: a };
        }),
      })),
    }));
    const slots = s.slots?.map((x) => (x.name === r.slot && x.attachment === r.key ? { ...x, attachment: to } : x));
    const animations = s.animations?.map((a): Animation => {
      let out = a;
      if (a.slots) {
        out = { ...out, slots: a.slots.map((g) => (g.name !== r.slot ? g : {
          ...g, timelines: g.timelines.map((t) => (t.name !== "attachment" ? t : { ...t, keys: t.keys.map((k) => (k.name === r.key ? { ...k, name: to } : k)) })),
        })) };
      }
      if (a.attachments) {
        out = { ...out, attachments: a.attachments.map((st) => ({
          ...st, slots: st.slots.map((sl) => (sl.slot !== r.slot ? sl : { ...sl, attachments: sl.attachments.map((g) => (g.name === r.key ? { ...g, name: to } : g)) })),
        })) };
      }
      return out;
    });
    return { ...s, ...(skins ? { skins } : {}), ...(slots ? { slots } : {}), ...(animations ? { animations } : {}) };
  };
}

/** Set fields of an attachment. */
export function updateAttachment(r: AttachmentRef, patch: AttachmentPatch): Edit<Skeleton> {
  return (s) => {
    refuseNonFinite(`Attachment "${r.key}"`, patch);
    const a = findAttachment(s, r);
    if (!a) throw new EditRefused(`There is no attachment "${r.key}" in "${r.slot}" of "${r.skin}".`);
    if ((patch.width !== undefined && !(patch.width > 0)) || (patch.height !== undefined && !(patch.height > 0))) throw new EditRefused("Width and height must be above 0.");
    if (patch.color !== undefined && !/^[0-9a-f]{8}$/i.test(patch.color)) throw new EditRefused("A colour is 8 hex digits, rrggbbaa.");
    const next: Record<string, unknown> = { ...a };
    let changed = false;
    for (const [k, v] of Object.entries(patch)) {
      if (next[k] === v) continue;
      changed = true;
      if (v === undefined) delete next[k]; else next[k] = v;
    }
    if (!changed) return s;
    return onSkinSlot(s, r.skin, r.slot, (entries) => entries.map((e) => (e.key === r.key ? { ...e, attachment: next as unknown as Attachment } : e)));
  };
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

/** `s` with the attachment at `r` replaced by `a` (it must exist). */
export function replaceAttachment(s: Skeleton, r: AttachmentRef, a: Attachment): Skeleton {
  return onSkinSlot(s, r.skin, r.slot, (entries) => entries.map((e) => (e.key === r.key ? { ...e, attachment: a } : e)));
}
