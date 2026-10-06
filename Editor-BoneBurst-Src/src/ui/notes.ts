import { missingRegions } from "@/engine/atlasCheck";
import type { AtlasImages } from "@/engine/regions";
import type { Skipped } from "@/engine/rigTypes";
import { profileIssues } from "@/model/profile";
import type { Skeleton } from "@/model/skeleton";
import type { Selection } from "./session";
import type { Posed } from "./stage/posed";

/** What a note is about: something to select, or an animation to show. */
export type NoteSubject = Selection | { readonly kind: "animation"; readonly name: string };

/** One thing the editor tells the user about the document: what, and about which thing. */
export interface Note {
  readonly text: string;
  readonly subject: NoteSubject | null;
}

/**
 * The notes about the document as it is now (E8-PLAN step 1): what the profile says of it (what
 * BoneBurst's readers require), the attachments whose regions the atlas lacks, and what the engine
 * skips. Worked out again whenever the document changes, so an edit that breaks the file says so
 * at once, and an undo takes the note away.
 */
export function documentNotes(doc: Skeleton, images: AtlasImages | null, skipped: readonly Skipped[]): Note[] {
  const at = subjects(doc);
  return [
    ...profileIssues(doc).map((i) => ({ text: `${i.where}: ${i.message}`, subject: at(i.where) })),
    ...(images ? missingRegions(doc, images) : []).map((i) => ({ text: `${i.where}: ${i.message}`, subject: at(i.where) })),
    ...skipped.map((k) => ({ text: k.message, subject: (k.subject ?? null) as NoteSubject | null })),
  ];
}

/**
 * The bones the pose shown leaves without a pose (E7 F6): a constraint they are in cannot be
 * solved there, and BoneBurst's runtime poses them to nothing too. One note, naming them.
 */
export function poseNotes(doc: Skeleton, p: Posed | null, where: string): Note[] {
  if (!p) return [];
  const bones = doc.bones ?? [], lost: string[] = [];
  for (let i = 0; i < bones.length; i++) {
    if (p.rig.active[i] && ![...p.rig.matrix(i)].every(Number.isFinite)) lost.push(bones[i]!.name);
  }
  if (!lost.length) return [];
  const names = lost.slice(0, 5).map((n) => `"${n}"`).join(", ") + (lost.length > 5 ? ` and ${lost.length - 5} more` : "");
  return [{ text: `${where}: ${lost.length === 1 ? "bone" : `${lost.length} bones`} ${names} ${lost.length === 1 ? "has" : "have"} no pose: a constraint ${lost.length === 1 ? "it is" : "they are"} in cannot be solved here; ${lost.length === 1 ? "it is" : "they are"} not drawn`, subject: { kind: "bone", name: lost[0]! } }];
}

/** The bones Posed leaves without a pose, by name (Properties says so for a selected one). */
export function unposed(doc: Skeleton, p: Posed | null): Set<string> {
  const out = new Set<string>();
  if (!p) return out;
  (doc.bones ?? []).forEach((b, i) => { if (p.rig.active[i] && ![...p.rig.matrix(i)].every(Number.isFinite)) out.add(b.name); });
  return out;
}

/**
 * What a profile `where` names: `bones[i]`, `slots[i]`, `constraints[i]`, a skin, its slot or
 * attachment (`skins/<skin>/<slot>/<key>`), an animation (`animations/<name>…`). Names may hold
 * `/`, so skins and animations are matched against the document's own, longest first.
 */
function subjects(doc: Skeleton): (where: string) => NoteSubject | null {
  const paths: [string, NoteSubject][] = [];
  for (const k of doc.skins ?? []) {
    paths.push([`skins/${k.name}`, { kind: "skin", name: k.name }]);
    for (const ss of k.attachments ?? []) {
      paths.push([`skins/${k.name}/${ss.slot}`, { kind: "slot", name: ss.slot }]);
      for (const e of ss.entries) paths.push([`skins/${k.name}/${ss.slot}/${e.key}`, { kind: "attachment", skin: k.name, slot: ss.slot, key: e.key }]);
    }
  }
  for (const a of doc.animations ?? []) paths.push([`animations/${a.name}`, { kind: "animation", name: a.name }]);
  paths.sort((a, b) => b[0].length - a[0].length);
  return (where) => {
    const indexed = /^(bones|slots|constraints)\[(\d+)\]/.exec(where);
    if (indexed) {
      const i = Number(indexed[2]);
      if (indexed[1] === "bones") { const b = doc.bones?.[i]; return b ? { kind: "bone", name: b.name } : null; }
      if (indexed[1] === "slots") { const s = doc.slots?.[i]; return s ? { kind: "slot", name: s.name } : null; }
      const c = doc.constraints?.[i];
      return c ? { kind: "constraint", type: c.type, name: c.name } : null;
    }
    for (const [p, subject] of paths) if (where === p || where.startsWith(`${p}/`) || where.startsWith(`${p}[`)) return subject;
    return null;
  };
}
