import { isArray, isObject, type Json, type JsonObject } from "@/model/json";
import type { Issue } from "@/model/issue";
import { EMPTY_SIDECAR, type Guide, type Note, type TagEntry, type Reference, SIDECAR_FORMAT, SIDECAR_VERSION, type Sidecar } from "@/model/sidecar";
import { parseJson, stringifyJson } from "./json";

/**
 * Read a sidecar. One whose `format` or `version` this editor does not know is not guessed at:
 * the result is the empty sidecar, with an issue (SPEC §3). An entry that does not read is
 * dropped with an issue: the sidecar holds view state, never the document. A top-level `motion` (TwinSpline's paths, removed
 * 2026-10-09: docs/REMOVE-TWINSPLINE-PLAN.md) is dropped, not kept, so the next save leaves it out.
 */
export function readSidecar(text: string): { sidecar: Sidecar; issues: Issue[] } {
  const issues: Issue[] = [];
  const refuse = (message: string) => ({ sidecar: EMPTY_SIDECAR, issues: [{ where: "sidecar", message }] });
  let root: Json;
  try { root = parseJson(text); } catch (e) { return refuse(`not JSON: ${(e as Error).message}`); }
  if (!isObject(root)) return refuse("not a JSON object");
  if (root.get("format") !== SIDECAR_FORMAT) return refuse(`not a ${SIDECAR_FORMAT} file`);
  const version = root.get("version");
  if (version !== SIDECAR_VERSION) return refuse(`version ${String(version)}; this editor reads ${SIDECAR_VERSION}`);

  const each = <T>(key: string, one: (o: JsonObject) => T | null): T[] => {
    const v = root.get(key);
    if (v === undefined) return [];
    if (!isArray(v)) { issues.push({ where: key, message: "not a list; ignored" }); return []; }
    const out: T[] = [];
    for (const [i, e] of v.entries()) {
      const r = isObject(e) ? one(e) : null;
      if (r) out.push(r); else issues.push({ where: `${key}[${i}]`, message: "does not read; dropped" });
    }
    return out;
  };
  const num = (o: JsonObject, k: string, d?: number) => { const v = o.get(k); return typeof v === "number" ? v : d; };
  const str = (o: JsonObject, k: string) => { const v = o.get(k); return typeof v === "string" ? v : undefined; };

  const guides = each<Guide>("guides", (o) => {
    const axis = o.get("axis"), at = num(o, "at");
    return (axis === "x" || axis === "y") && at !== undefined ? { axis, at } : null;
  });
  const references = each<Reference>("references", (o) => {
    const path = str(o, "path");
    return path ? { path, x: num(o, "x", 0)!, y: num(o, "y", 0)!, scale: num(o, "scale", 1)!, opacity: num(o, "opacity", 1)! } : null;
  });
  const notes = each<Note>("notes", (o) => {
    const text2 = str(o, "text"), author = str(o, "author"), about = str(o, "about");
    return text2 === undefined ? null : { text: text2, ...(author !== undefined ? { author } : {}), ...(about !== undefined ? { about } : {}) };
  });
  // Tags: { "bone:leg": ["IK", "left"], … }; an entry that does not read is dropped.
  const tg = root.get("tags"), tags: TagEntry[] = [];
  if (isObject(tg)) for (const [key, v] of tg) {
    const list = isArray(v) ? v.filter((q): q is string => typeof q === "string" && q.trim() !== "") : [];
    if (list.length) tags.push({ key, tags: list });
  }
  const view = root.get("view");
  if (view !== undefined && !isObject(view)) issues.push({ where: "view", message: "not an object; ignored" });
  const extra = new Map([...root].filter(([k]) => !["format", "version", "view", "guides", "references", "notes", "motion", "tags"].includes(k)));
  return { sidecar: { view: isObject(view) ? view : new Map(), guides, references, notes, tags, extra }, issues };
}

export function writeSidecar(s: Sidecar): string {
  const entries: [string, Json][] = [
    ["format", SIDECAR_FORMAT], ["version", SIDECAR_VERSION], ["view", s.view],
    ["guides", s.guides.map((g) => new Map<string, Json>([["axis", g.axis], ["at", g.at]]))],
    ["references", s.references.map((r) => new Map<string, Json>([["path", r.path], ["x", r.x], ["y", r.y], ["scale", r.scale], ["opacity", r.opacity]]))],
    ["notes", s.notes.map((n) => new Map<string, Json>([["text", n.text], ...(n.author !== undefined ? [["author", n.author] as [string, Json]] : []), ...(n.about !== undefined ? [["about", n.about] as [string, Json]] : [])]))],
    ...(s.tags.length ? [["tags", new Map<string, Json>(s.tags.map((e) => [e.key, [...e.tags]] as [string, Json]))] as [string, Json]] : []),
  ];
  return `${stringifyJson(new Map([...entries, ...s.extra]))}\n`;
}

/** The sidecar's file name for a skeleton file name: `hero.json` → `hero.bb.json`. */
export function sidecarName(skeletonFile: string): string {
  return `${skeletonFile.replace(/\.json$/i, "")}.bb.json`;
}
