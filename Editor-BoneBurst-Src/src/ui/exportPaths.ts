import { setupXY, translateKeyCount, translateKeysAt, writeTranslateKeys } from "@/edit/pathKeys";
import type { MotionPath } from "@/model/sidecar";
import type { Skeleton } from "@/model/skeleton";
import { animationDuration } from "@/model/timelines";
import type { KeysOver } from "./pathKeysOver";

/**
 * The Spine keys export (docs/UNITY-EXPORT-PLAN.md, step 2): the document's copy for Unity, where a bone that uses its path has its translate
 * keys replaced by keys made from the path over the animation's length. Every other timeline and bone is as the document has it; the path is
 * never written and the document is never changed. Pure: the keys of a path are `keysFor`'s (`pathKeysOver` with a rig).
 */

/** A bone whose translate keys came from its path. */
export interface BakedBone {
  readonly animation: string;
  readonly bone: string;
  readonly keys: number;
  readonly duration: number;
  readonly length: number;
  /** A looping path whose runs do not fill the animation: its repeat does not meet the animation's loop point. */
  readonly jumps: boolean;
}

export interface BakeReport {
  readonly baked: readonly BakedBone[];
  /** `animation/bone` of the bones with translate keys that stay as the document has them. */
  readonly fromKeys: readonly string[];
}

/** The document for export: `doc` when no bone uses a path in it (the same object, so the file is byte for byte what it was), else the copy with those bones baked. */
export function exportDoc(doc: Skeleton, paths: readonly MotionPath[], keysFor: (m: MotionPath, length: number) => KeysOver): { doc: Skeleton; report: BakeReport } {
  let out = doc;
  const baked: BakedBone[] = [], fromKeys: string[] = [];
  for (const a of doc.animations ?? []) {
    const length = animationDuration(a), used = new Map(paths.filter((p) => p.animation === a.name && p.active !== false && doc.bones?.some((b) => b.name === p.bone)).map((p) => [p.bone, p]));
    for (const [bone, m] of used) {
      const made = keysFor(m, length);
      if (!made.keys.length) continue;
      const keys = translateKeysAt(setupXY(out, bone), made.keys);
      out = writeTranslateKeys(a.name, bone, keys)(out);
      baked.push({ animation: a.name, bone, keys: keys.length, duration: m.duration, length, jumps: m.loop && !made.wholeRuns });
    }
    for (const b of doc.bones ?? []) if (!used.has(b.name) && translateKeyCount(a, b.name) > 0) fromKeys.push(`${a.name}/${b.name}`);
  }
  return { doc: out, report: { baked, fromKeys } };
}

/** What the status line and the AI say after an export that baked paths; empty when none was baked. */
export function bakeSummary(r: BakeReport): string {
  if (!r.baked.length) return "";
  const keys = r.baked.reduce((n, b) => n + b.keys, 0);
  const parts = [`${r.baked.length} bone${r.baked.length === 1 ? "" : "s"} from their TwinSpline (${keys} keys), ${r.fromKeys.length} from their key frames`];
  for (const b of r.baked) if (b.jumps) parts.push(`${b.animation}/${b.bone}: its ${+b.duration.toFixed(3)} s path does not divide ${b.animation}'s ${+b.length.toFixed(3)} s, so the loop jumps`);
  return parts.join("; ");
}
