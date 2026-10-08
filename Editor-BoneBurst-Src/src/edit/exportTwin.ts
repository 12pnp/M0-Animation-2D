import type { MotionNode, MotionPath } from "@/model/sidecar";
import type { Skeleton } from "@/model/skeleton";
import { keyLists } from "@/model/timelines";
import { EditRefused } from "./history";
import { deleteTranslateKeys, TRANSLATE_TIMELINES } from "./pathKeys";

/**
 * The TwinSpline export (docs/UNITY-EXPORT-PLAN.md, "The TwinSpline mode"): every bone that has translate motion leaves as a path, in a file of
 * its own that holds nothing else; the skeleton copy loses those bones' translate timelines and stays plain Spine. A bone with a path
 * exports it as it is; a bone with translate keys only is converted (one-time, approximate) by the caller's `convert`. Pure: the document is
 * never changed, and the conversion (which needs a posed rig) is passed in.
 */

export const TWINSPLINE_VERSION = 1;

/** A node as the file has it: the sidecar's node without the editor's own number. */
export interface TwinNode {
  readonly x: number; readonly y: number;
  readonly tx?: number; readonly ty?: number; readonly bx?: number; readonly by?: number;
  readonly speed?: number; readonly ss?: number; readonly sb?: number;
}

/** One bone's path in one animation, in seconds: the sidecar's `MotionPath` without the editor's state (animation and bone are the file's keys). */
export interface TwinPath {
  /** The bone whose space the nodes are in; absent = the world's (a root bone with no parent chosen). */
  readonly parent?: string;
  readonly duration: number;
  readonly loop: boolean;
  readonly closed: boolean;
  readonly nodes: readonly TwinNode[];
}

export interface TwinFile {
  readonly twinspline: number;
  readonly animations: Readonly<Record<string, Readonly<Record<string, TwinPath>>>>;
}

/** A bone exported as a path: its own (`path`) or converted from its keys (`keys`, with how far the path strays from them at worst). */
export interface TwinLine { readonly animation: string; readonly bone: string; readonly source: "path" | "keys"; readonly stray?: number }

/** A bone with translate keys that stayed keys, and why. */
export interface TwinKept { readonly animation: string; readonly bone: string; readonly why: string }

export interface TwinReport { readonly lines: readonly TwinLine[]; readonly kept: readonly TwinKept[] }

/** The conversion of a bone's translate keys to a path, or null when there is none to make; may throw `EditRefused` with the reason. */
export type ConvertKeys = (animation: string, bone: string) => { path: MotionPath; stray: number } | null;

/** The most a converted path may stray from the keyed motion before the bone stays as keys, in units. */
export const DEFAULT_MAX_STRAY = 0.5;

const NODE_FIELDS = ["x", "y", "tx", "ty", "bx", "by", "speed", "ss", "sb"] as const;

function twinPath(m: MotionPath, parent: string | undefined): TwinPath {
  const nodes = m.nodes.map((n: MotionNode) => {
    const out: Record<string, number> = {};
    for (const f of NODE_FIELDS) if (n[f] !== undefined) out[f] = n[f]!;
    return out as unknown as TwinNode;
  });
  return { ...(parent !== undefined ? { parent } : {}), duration: m.duration, loop: m.loop, closed: m.closed, nodes };
}

export function exportTwin(doc: Skeleton, paths: readonly MotionPath[], convert: ConvertKeys, maxStray: number = DEFAULT_MAX_STRAY): { skeleton: Skeleton; file: TwinFile; report: TwinReport } {
  const order = (doc.bones ?? []).map((b) => b.name);
  const animations: Record<string, Record<string, TwinPath>> = {};
  const lines: TwinLine[] = [], kept: TwinKept[] = [];
  let skeleton = doc;
  for (const a of doc.animations ?? []) {
    const keyed = new Set<string>();
    for (const l of keyLists(a)) if (l.path.section === "bones" && (TRANSLATE_TIMELINES as readonly string[]).includes(l.path.timeline) && l.keys.length > 0) keyed.add(l.path.owner);
    const pathOf = new Map(paths.filter((p) => p.animation === a.name).map((p) => [p.bone, p]));
    const bones = [...new Set([...keyed, ...pathOf.keys()])].sort((x, y) => order.indexOf(x) - order.indexOf(y));
    const out: Record<string, TwinPath> = {};
    for (const bone of bones) {
      const own = pathOf.get(bone), parentName = doc.bones?.find((b) => b.name === bone)?.parent;
      if (own && own.active !== false) {
        out[bone] = twinPath(own, own.parent !== undefined ? own.parent : parentName);
        lines.push({ animation: a.name, bone, source: "path" });
      } else if (keyed.has(bone)) {
        try {
          const made = convert(a.name, bone);
          if (!made) { kept.push({ animation: a.name, bone, why: "it has no pose to convert from" }); continue; }
          if (made.stray > maxStray) { kept.push({ animation: a.name, bone, why: `a path would stray ${made.stray.toFixed(2)} from its keys (more than ${maxStray})` }); continue; }
          out[bone] = twinPath(made.path, made.path.parent);
          lines.push({ animation: a.name, bone, source: "keys", stray: made.stray });
        } catch (err) {
          if (!(err instanceof EditRefused)) throw err;
          kept.push({ animation: a.name, bone, why: err.message });
          continue;
        }
      } else continue;
      skeleton = deleteTranslateKeys(a.name, bone)(skeleton);
    }
    if (Object.keys(out).length) animations[a.name] = out;
  }
  return { skeleton, file: { twinspline: TWINSPLINE_VERSION, animations }, report: { lines, kept } };
}

/** The file's text: one definition of the format, read back by `parseTwinSpline`. */
export function writeTwinSpline(file: TwinFile): string {
  return JSON.stringify(file, null, 2) + "\n";
}

/** A TwinSpline file read back; throws an Error saying what is wrong. */
export function parseTwinSpline(text: string): TwinFile {
  const v = JSON.parse(text) as { twinspline?: unknown; animations?: unknown };
  if (v.twinspline !== TWINSPLINE_VERSION) throw new Error(`Not a TwinSpline file of version ${TWINSPLINE_VERSION}.`);
  if (typeof v.animations !== "object" || v.animations === null) throw new Error("A TwinSpline file has an \"animations\" object.");
  for (const [an, bones] of Object.entries(v.animations)) for (const [bone, p] of Object.entries(bones as Record<string, TwinPath>)) {
    const where = `${an}/${bone}`;
    if (!Array.isArray(p.nodes) || p.nodes.length < 2) throw new Error(`${where}: a path has at least two nodes.`);
    if (!(p.duration > 0)) throw new Error(`${where}: the duration is a number above 0.`);
    if (typeof p.loop !== "boolean" || typeof p.closed !== "boolean") throw new Error(`${where}: loop and closed are true or false.`);
  }
  return v as TwinFile;
}

/** The sentence the status line and the AI say after a TwinSpline export. */
export function twinSummary(r: TwinReport): string {
  const own = r.lines.filter((l) => l.source === "path").length, conv = r.lines.filter((l) => l.source === "keys");
  const worst = conv.reduce((m, l) => Math.max(m, l.stray ?? 0), 0);
  const parts = [`${r.lines.length} bone${r.lines.length === 1 ? "" : "s"} as TwinSpline (${own} from their paths, ${conv.length} converted from keys${conv.length ? `, at worst ${worst.toFixed(2)} from the keyed motion` : ""})`];
  if (r.kept.length) parts.push(`${r.kept.length} left as keys: ${r.kept.map((k) => `${k.animation}/${k.bone} (${k.why})`).join("; ")}`);
  return parts.join("; ");
}
