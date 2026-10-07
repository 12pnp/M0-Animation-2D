import { isArray, isObject, type Json, type JsonObject } from "@/model/json";
import type { Issue } from "@/model/issue";
import { EMPTY_SIDECAR, type Guide, type MotionNode, type MotionPath, type Note, type Reference, SIDECAR_FORMAT, SIDECAR_VERSION, type Sidecar } from "@/model/sidecar";
import { parseJson, stringifyJson } from "./json";

/**
 * Read a sidecar. One whose `format` or `version` this editor does not know is not guessed at:
 * the result is the empty sidecar, with an issue (SPEC §3). An entry that does not read is
 * dropped with an issue: the sidecar holds view state, never the document.
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
  const motion = each<MotionPath>("motion", (o) => {
    const animation = str(o, "animation"), bone = str(o, "bone"), nodes = o.get("nodes"), frames = num(o, "frames");
    // An earlier build's path (seconds, pins) has no frames: dropped.
    if (animation === undefined || bone === undefined || !isArray(nodes) || nodes.length < 2 || frames === undefined || !(frames >= 2)) return null;
    const ns: MotionNode[] = [];
    for (const n of nodes) {
      if (!isObject(n) || typeof n.get("x") !== "number" || typeof n.get("y") !== "number") return null;
      const tx = num(n, "tx"), ty = num(n, "ty"), bx = num(n, "bx"), by = num(n, "by");
      const id = num(n, "id");
      ns.push({ x: n.get("x") as number, y: n.get("y") as number, ...(tx !== undefined && ty !== undefined ? { tx, ty } : {}), ...(bx !== undefined && by !== undefined ? { bx, by } : {}), ...(id !== undefined && Number.isInteger(id) && id > 0 ? { id } : {}) });
    }
    const numbers = (k: string): number[] => { const v = o.get(k); return isArray(v) ? v.filter((q): q is number => typeof q === "number") : []; };
    const baked = str(o, "baked"), cv = o.get("curves");
    const curves = isArray(cv) ? cv.map((c) => (isArray(c) ? c.filter((q): q is number => typeof q === "number") : [])) : [];
    return { animation, bone, nodes: ns, closed: o.get("closed") !== false, frames, starts: numbers("starts"), speeds: numbers("speeds"), ...(curves.some((c) => c.length) ? { curves } : {}), ...(baked !== undefined ? { baked } : {}) };
  });
  const view = root.get("view");
  if (view !== undefined && !isObject(view)) issues.push({ where: "view", message: "not an object; ignored" });
  const extra = new Map([...root].filter(([k]) => !["format", "version", "view", "guides", "references", "notes", "motion"].includes(k)));
  return { sidecar: { view: isObject(view) ? view : new Map(), guides, references, notes, motion, extra }, issues };
}

export function writeSidecar(s: Sidecar): string {
  const entries: [string, Json][] = [
    ["format", SIDECAR_FORMAT], ["version", SIDECAR_VERSION], ["view", s.view],
    ["guides", s.guides.map((g) => new Map<string, Json>([["axis", g.axis], ["at", g.at]]))],
    ["references", s.references.map((r) => new Map<string, Json>([["path", r.path], ["x", r.x], ["y", r.y], ["scale", r.scale], ["opacity", r.opacity]]))],
    ["notes", s.notes.map((n) => new Map<string, Json>([["text", n.text], ...(n.author !== undefined ? [["author", n.author] as [string, Json]] : []), ...(n.about !== undefined ? [["about", n.about] as [string, Json]] : [])]))],
    ...(s.motion.length ? [["motion", s.motion.map((m) => new Map<string, Json>([
      ["animation", m.animation], ["bone", m.bone],
      ["nodes", m.nodes.map((n) => new Map<string, Json>([["x", n.x], ["y", n.y], ...(n.tx !== undefined && n.ty !== undefined ? [["tx", n.tx] as [string, Json], ["ty", n.ty] as [string, Json]] : []), ...(n.bx !== undefined && n.by !== undefined ? [["bx", n.bx] as [string, Json], ["by", n.by] as [string, Json]] : []), ...(n.id !== undefined ? [["id", n.id] as [string, Json]] : [])]))],
      ["closed", m.closed], ["frames", m.frames], ["starts", [...m.starts]], ["speeds", [...m.speeds]],
      ...(m.curves?.some((c) => c.length) ? [["curves", m.curves.map((c) => [...c])] as [string, Json]] : []),
      ...(m.baked !== undefined ? [["baked", m.baked] as [string, Json]] : []),
    ]))] as [string, Json]] : []),
  ];
  return `${stringifyJson(new Map([...entries, ...s.extra]))}\n`;
}

/** The sidecar's file name for a skeleton file name: `hero.json` → `hero.bb.json`. */
export function sidecarName(skeletonFile: string): string {
  return `${skeletonFile.replace(/\.json$/i, "")}.bb.json`;
}
