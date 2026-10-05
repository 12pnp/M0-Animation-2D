import type { Animation, Attachment, Skeleton, Skin, SkinTimelines } from "@/model/skeleton";
import { type AttachmentRef, findAttachment } from "./attachments";
import { EditRefused, type Edit } from "./history";

/**
 * Skin edits (Format-Json-Atlas.md §8.1). Deform and sequence keys are stored per skin
 * (`animations.*.attachments.<skin>`), and linked meshes name their source's skin, so both follow
 * every change here.
 */

export const SKIN_LISTS = ["bones", "ik", "transform", "path", "physics", "slider"] as const;
export type SkinList = (typeof SKIN_LISTS)[number];

const DEFAULT = "default";

function skinOf(s: Skeleton, name: string): Skin {
  const k = s.skins?.find((x) => x.name === name);
  if (!k) throw new EditRefused(`There is no skin "${name}".`);
  return k;
}

function checkNew(s: Skeleton, name: string): void {
  if (!name.trim()) throw new EditRefused("A skin needs a name.");
  if (name === DEFAULT) throw new EditRefused(`"${DEFAULT}" is the default skin's name.`);
  if (s.skins?.some((x) => x.name === name)) throw new EditRefused(`There is already a skin "${name}".`);
}

/** The skin a linked mesh takes its source from (absent: the default skin). */
const sourceSkin = (a: Attachment) => a.skin ?? DEFAULT;

/** `s` with each animation's per-skin timelines changed by `f`. */
function onTimelines(s: Skeleton, f: (ts: readonly SkinTimelines[]) => readonly SkinTimelines[]): Skeleton {
  if (!s.animations) return s;
  return {
    ...s,
    animations: s.animations.map((a): Animation => {
      if (!a.attachments) return a;
      const next = f(a.attachments).filter((t) => t.slots.length);
      if (next.length) return { ...a, attachments: next };
      const { attachments: _, ...rest } = a;
      return rest as Animation;
    }),
  };
}

/** `s` with every attachment in every skin changed by `f` (where it is: skin, slot, key). */
function onAttachments(s: Skeleton, f: (a: Attachment, where: AttachmentRef) => Attachment): Skeleton {
  if (!s.skins) return s;
  return {
    ...s,
    skins: s.skins.map((k) => (!k.attachments ? k : {
      ...k, attachments: k.attachments.map((ss) => ({ ...ss, entries: ss.entries.map((e) => ({ ...e, attachment: f(e.attachment, { skin: k.name, slot: ss.slot, key: e.key }) })) })),
    })),
  };
}

/** Linked meshes elsewhere that take a source from `skin`. */
function linkedInto(s: Skeleton, skin: string, outside: (where: AttachmentRef) => boolean): string[] {
  const out: string[] = [];
  for (const k of s.skins ?? []) for (const ss of k.attachments ?? []) for (const e of ss.entries) {
    const where = { skin: k.name, slot: ss.slot, key: e.key };
    if (e.attachment.source !== undefined && sourceSkin(e.attachment) === skin && outside(where)) out.push(`${k.name}/${ss.slot}/${e.key}`);
  }
  return out;
}

export function addSkin(name: string): Edit<Skeleton> {
  return (s) => {
    checkNew(s, name);
    return { ...s, skins: [...(s.skins ?? []), { name, extra: new Map() }] };
  };
}

/** Delete a skin with its attachments and their timelines. Not the default skin, nor one another
 *  skin's linked mesh takes its source from. */
export function deleteSkin(name: string): Edit<Skeleton> {
  return (s) => {
    skinOf(s, name);
    if (name === DEFAULT) throw new EditRefused("The default skin cannot be deleted.");
    const linked = linkedInto(s, name, (w) => w.skin !== name);
    if (linked.length) throw new EditRefused(`"${name}" cannot be deleted: the linked mesh ${linked[0]} takes its source from it.`);
    const out = onTimelines(s, (ts) => ts.filter((t) => t.skin !== name));
    return { ...out, skins: out.skins!.filter((k) => k.name !== name) };
  };
}

/** Rename a skin, its timelines and the linked meshes that name it. Not the default skin. */
export function renameSkin(from: string, to: string): Edit<Skeleton> {
  return (s) => {
    if (from === to) return s;
    skinOf(s, from);
    if (from === DEFAULT) throw new EditRefused("The default skin keeps its name.");
    checkNew(s, to);
    let out = onTimelines(s, (ts) => ts.map((t) => (t.skin === from ? { ...t, skin: to } : t)));
    out = onAttachments(out, (a) => (a.source !== undefined && a.skin === from ? { ...a, skin: to } : a));
    return { ...out, skins: out.skins!.map((k) => (k.name === from ? { ...k, name: to } : k)) };
  };
}

/** A copy of a skin under a new name: its attachments, lists and timelines. Linked meshes in the
 *  copy that took their source from the original take it from the copy. */
export function duplicateSkin(from: string, to: string): Edit<Skeleton> {
  return (s) => {
    const k = skinOf(s, from);
    checkNew(s, to);
    const copy: Skin = {
      ...k, name: to,
      ...(k.attachments ? {
        attachments: k.attachments.map((ss) => ({
          ...ss, entries: ss.entries.map((e) => (e.attachment.source !== undefined && sourceSkin(e.attachment) === from
            ? { ...e, attachment: { ...e.attachment, skin: to } } : e)),
        })),
      } : {}),
    };
    const out = onTimelines(s, (ts) => {
      const mine = ts.find((t) => t.skin === from);
      return mine ? [...ts, { ...mine, skin: to }] : ts;
    });
    return { ...out, skins: [...out.skins!, copy] };
  };
}

/** Turn a bone or constraint on or off for a skin (the skin's `bones`, `ik`, … lists). */
export function setSkinMember(skin: string, list: SkinList, name: string, on: boolean): Edit<Skeleton> {
  return (s) => {
    const k = skinOf(s, skin);
    const exists = list === "bones" ? s.bones?.some((b) => b.name === name) : s.constraints?.some((c) => c.type === list && c.name === name);
    if (!exists) throw new EditRefused(`There is no ${list === "bones" ? "bone" : `${list} constraint`} "${name}".`);
    const current = k[list] ?? [];
    if (current.includes(name) === on) return s;
    const next = on ? [...current, name] : current.filter((n) => n !== name);
    const { [list]: _, ...rest } = k;
    const skinNext = (next.length ? { ...rest, [list]: next } : rest) as Skin;
    return { ...s, skins: s.skins!.map((x) => (x.name === skin ? skinNext : x)) };
  };
}

/**
 * Move an attachment to another skin, with its deform and sequence timelines; linked meshes that
 * take it as their source follow it. Refused when the other skin has that key for that slot.
 */
export function moveAttachment(r: AttachmentRef, toSkin: string): Edit<Skeleton> {
  return (s) => {
    const a = findAttachment(s, r);
    if (!a) throw new EditRefused(`There is no attachment "${r.key}" in "${r.slot}" of "${r.skin}".`);
    if (toSkin === r.skin) return s;
    skinOf(s, toSkin);
    if (findAttachment(s, { ...r, skin: toSkin })) throw new EditRefused(`"${toSkin}" already has an attachment "${r.key}" in "${r.slot}".`);
    // Out of the old skin, into the new one.
    let out: Skeleton = {
      ...s,
      skins: s.skins!.map((k) => {
        if (k.name === r.skin) {
          const attachments = (k.attachments ?? []).map((ss) => (ss.slot !== r.slot ? ss : { ...ss, entries: ss.entries.filter((e) => e.key !== r.key) })).filter((ss) => ss.entries.length);
          return { ...k, attachments };
        }
        if (k.name === toSkin) {
          const slots = k.attachments ?? [];
          const has = slots.some((ss) => ss.slot === r.slot);
          const attachments = has
            ? slots.map((ss) => (ss.slot === r.slot ? { ...ss, entries: [...ss.entries, { key: r.key, attachment: a }] } : ss))
            : [...slots, { slot: r.slot, entries: [{ key: r.key, attachment: a }] }];
          return { ...k, attachments };
        }
        return k;
      }),
    };
    // Linked meshes that took it as their source take it from its new skin.
    out = onAttachments(out, (x, w) => {
      if (x.source !== r.key || sourceSkin(x) !== r.skin || (x.slot ?? w.slot) !== r.slot) return x;
      if (toSkin === DEFAULT) { const { skin: _, ...rest } = x; return rest as Attachment; }
      return { ...x, skin: toSkin };
    });
    // Its timelines move with it.
    return onTimelines(out, (ts) => {
      const moved = ts.find((t) => t.skin === r.skin)?.slots.find((sl) => sl.slot === r.slot)?.attachments.find((g) => g.name === r.key);
      if (!moved) return ts;
      const without = ts.map((t) => (t.skin !== r.skin ? t : {
        ...t, slots: t.slots.map((sl) => (sl.slot !== r.slot ? sl : { ...sl, attachments: sl.attachments.filter((g) => g.name !== r.key) })).filter((sl) => sl.attachments.length),
      }));
      const target = without.find((t) => t.skin === toSkin);
      if (!target) return [...without, { skin: toSkin, slots: [{ slot: r.slot, attachments: [moved] }] }];
      return without.map((t) => {
        if (t.skin !== toSkin) return t;
        const has = t.slots.some((sl) => sl.slot === r.slot);
        return {
          ...t,
          slots: has ? t.slots.map((sl) => (sl.slot === r.slot ? { ...sl, attachments: [...sl.attachments, moved] } : sl)) : [...t.slots, { slot: r.slot, attachments: [moved] }],
        };
      });
    });
  };
}
