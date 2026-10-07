import type { Sidecar, TagEntry } from "@/model/sidecar";

/**
 * Tags (docs/TAGS-PLAN.md): a list of words on any element of the rig, kept in the sidecar beside the skeleton (they do not
 * change what the skeleton means). An element is named by a key made from what it is: `bone:leg`, `slot:eye`,
 * `attachment:default/eye/open`, `skin:red`, `constraint:ik/reach`, `event:step`. Pure: the sidecar in, the sidecar out.
 */

/** The element a tag is on: the same shapes as the rig tree's selection. */
export type Tagged =
  | { readonly kind: "bone" | "slot" | "skin" | "event"; readonly name: string }
  | { readonly kind: "attachment"; readonly skin: string; readonly slot: string; readonly key: string }
  | { readonly kind: "constraint"; readonly type: string; readonly name: string };

export function tagKeyOf(t: Tagged): string {
  if (t.kind === "attachment") return `attachment:${t.skin}/${t.slot}/${t.key}`;
  if (t.kind === "constraint") return `constraint:${t.type}/${t.name}`;
  return `${t.kind}:${t.name}`;
}

/** A tag as typed: trimmed, inner spaces folded, no commas, at most 40 characters; empty when nothing is left. */
export function cleanTag(text: string): string {
  return text.replace(/[,\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 40).trim();
}

/** Several tags typed at once, split at commas (a repeat once, case of the first kept). */
export function parseTags(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(",")) {
    const t = cleanTag(part);
    if (t && !out.some((o) => o.toLowerCase() === t.toLowerCase())) out.push(t);
  }
  return out;
}

export function tagsFor(s: Sidecar, key: string): readonly string[] {
  return s.tags.find((e) => e.key === key)?.tags ?? [];
}

function set(s: Sidecar, key: string, tags: readonly string[]): Sidecar {
  const rest = s.tags.filter((e) => e.key !== key);
  const next: TagEntry[] = tags.length ? [...rest, { key, tags }] : rest;
  return { ...s, tags: next };
}

/** Tags added to the element (the ones it has are left; case does not make a new one). */
export function withTags(s: Sidecar, key: string, add: readonly string[]): Sidecar {
  const have = tagsFor(s, key), fresh = add.filter((t) => !have.some((h) => h.toLowerCase() === t.toLowerCase()));
  return fresh.length ? set(s, key, [...have, ...fresh]) : s;
}

export function withoutTag(s: Sidecar, key: string, tag: string): Sidecar {
  const have = tagsFor(s, key), left = have.filter((h) => h.toLowerCase() !== tag.toLowerCase());
  return left.length === have.length ? s : set(s, key, left);
}

/** Every tag in use and how many elements have it, the most used first. */
export function tagCounts(s: Sidecar): { tag: string; count: number }[] {
  const counts = new Map<string, { tag: string; count: number }>();
  for (const e of s.tags) for (const t of e.tags) {
    const k = t.toLowerCase(), c = counts.get(k);
    if (c) c.count++; else counts.set(k, { tag: t, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/** Whether an element has a tag that matches a search: `#ik` a tag equal to it, anything else a tag that holds it (any case). */
export function tagMatches(tags: readonly string[], query: string): boolean {
  const q = query.toLowerCase();
  if (q.startsWith("#")) { const want = q.slice(1); return !!want && tags.some((t) => t.toLowerCase() === want); }
  return tags.some((t) => t.toLowerCase().includes(q));
}

/** An element renamed: its tags (and those of what hangs on it) go with it. */
export function renameTagged(s: Sidecar, from: Tagged, to: string): Sidecar {
  if (!s.tags.length) return s;
  const map = (key: string): string => {
    if (from.kind === "attachment") return key === tagKeyOf(from) ? tagKeyOf({ ...from, key: to }) : key;
    if (from.kind === "constraint") return key === tagKeyOf(from) ? tagKeyOf({ ...from, name: to }) : key;
    if (key === tagKeyOf(from)) return tagKeyOf({ ...from, name: to });
    // A slot's attachments, and a skin's, are keyed by their names too.
    const m = /^attachment:([^/]*)\/([^/]*)\/(.*)$/.exec(key);
    if (m && from.kind === "slot" && m[2] === from.name) return `attachment:${m[1]}/${to}/${m[3]}`;
    if (m && from.kind === "skin" && m[1] === from.name) return `attachment:${to}/${m[2]}/${m[3]}`;
    return key;
  };
  const next = s.tags.map((e) => ({ ...e, key: map(e.key) }));
  return next.some((e, i) => e.key !== s.tags[i]!.key) ? { ...s, tags: next } : s;
}
