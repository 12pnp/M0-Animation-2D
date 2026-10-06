import { boneNumber, BONE_DEFAULTS } from "@/model/defaults";
import type { Animation, Key, Skeleton } from "@/model/skeleton";
import { channelCount, channelValues, keyLists, keysAt, keyTime, pathId, type TimelinePath, frameTime, timeFrame } from "@/model/timelines";
import { type BoneProperty, keyBone, type LocalPose } from "./boneKeys";
import { type BonePatch, updateBone } from "./bones";
import { remapCurve, type Shape } from "./curves";
import { keyEvent } from "./events";
import { EditRefused, type Edit } from "./history";
import { deleteKeys, type KeyFields, type KeyRef, sameTime, setKey, setKeyCurve } from "./keys";

/**
 * Copy and paste (E6-PLAN step 4c): keys, with their times relative to the first and their eases
 * as shapes, pasted at a frame onto the same timelines of any animation; and a pose (bones' local
 * values), pasted as keys where it differs or as the setup pose. Pure: the clipboard is the UI's.
 */

/** One copied key: where, how many frames after the first, its values, and its ease as a shape per channel. */
export interface CopiedKey {
  readonly path: TimelinePath;
  readonly offset: number;
  readonly fields: KeyFields;
  readonly ease: "stepped" | readonly (Shape | null)[] | null;
}

export interface CopiedKeys { readonly kind: "keys"; readonly keys: readonly CopiedKey[] }

/** Each channel's ease from `k` to `next`, as a shape over the interval (null: straight). */
function shapes(path: TimelinePath, k: Key, next: Key | undefined): "stepped" | (Shape | null)[] | null {
  if (k.curve === "stepped") return "stepped";
  if (!Array.isArray(k.curve) || !next) return null;
  const t0 = keyTime(k), t1 = keyTime(next), v0 = channelValues(path, k, "start"), v1 = channelValues(path, next, "end");
  const out: (Shape | null)[] = [];
  for (let c = 0; c < channelCount(path); c++) {
    const from = { t0, t1, v0: [v0[c]!], v1: [v1[c]!] };
    // Onto the unit interval: the handles as shares of time and of the change.
    const unit = v1[c] === v0[c] ? null : remapCurve(k.curve.slice(c * 4, c * 4 + 4), from, { t0: 0, t1: 1, v0: [0], v1: [1] });
    out.push(Array.isArray(unit) ? [unit[0]!, unit[1]!, unit[2]!, unit[3]!] : null);
  }
  return out.every((x) => x === null) ? null : out;
}

/** The keys `refs` names in `a`, ready to paste: in time order, offsets in frames at `fps`. */
export function copyKeys(a: Animation, refs: readonly KeyRef[], fps: number): CopiedKeys {
  const out: { time: number; path: TimelinePath; key: Key; next: Key | undefined }[] = [];
  for (const { path, keys } of keyLists(a)) {
    keys.forEach((k, i) => {
      if (refs.some((r) => pathId(r.path) === pathId(path) && sameTime(r.time, keyTime(k)) && (r.name === undefined || r.name === k.name))) out.push({ time: keyTime(k), path, key: k, next: keys[i + 1] });
    });
  }
  if (!out.length) return { kind: "keys", keys: [] };
  const first = Math.min(...out.map((x) => timeFrame(x.time, fps)));
  return {
    kind: "keys",
    keys: out.map(({ time, path, key, next }) => {
      const { time: _t, curve: _c, extra: _e, ...fields } = key;
      return { path, offset: timeFrame(time, fps) - first, fields: fields as KeyFields, ease: path.section === "events" ? null : shapes(path, key, next) };
    }),
  };
}

/** Whether the rig has what the timeline at `path` belongs to. */
function owned(s: Skeleton, p: TimelinePath): boolean {
  switch (p.section) {
    case "bones": return !!s.bones?.some((b) => b.name === p.owner);
    case "slots": return !!s.slots?.some((x) => x.name === p.owner);
    case "attachments": return !!s.slots?.some((x) => x.name === p.slot) && !!s.skins?.some((k) => k.name === p.skin);
    case "ik": case "transform": case "path": case "physics": case "slider": return p.owner === "" || !!s.constraints?.some((c) => c.type === p.section && c.name === p.owner);
    case "drawOrder": return true;
    case "events": return true;
  }
}

/**
 * Paste `clip` into `animation` with its first key at `frame`: each key onto its timeline,
 * replacing a key there (an event goes beside the others on its frame), its ease fitted to its new
 * interval. Timelines the rig has no owner for are skipped and listed.
 */
export function pasteKeys(animation: string, clip: CopiedKeys, frame: number, fps: number): { edit: Edit<Skeleton>; skipped: (s: Skeleton) => string[] } {
  const skipped = (s: Skeleton) => [...new Set(clip.keys.filter((k) => !owned(s, k.path) || (k.path.section === "events" && !s.events?.some((e) => e.name === k.fields.name))).map((k) => pathId(k.path).replace(/\/[^/]+$/, "") + (k.path.section === "events" ? `/${String(k.fields.name)}` : "")))];
  const edit: Edit<Skeleton> = (s0) => {
    if (!s0.animations?.some((a) => a.name === animation)) throw new EditRefused(`There is no animation "${animation}".`);
    if (!clip.keys.length) throw new EditRefused("Nothing to paste: copy keys first.");
    const keys = clip.keys.filter((k) => owned(s0, k.path) && (k.path.section !== "events" || s0.events?.some((e) => e.name === k.fields.name)));
    if (!keys.length) throw new EditRefused("None of the copied keys' bones, slots or constraints are in this rig.");
    let s = s0;
    const placed: { ref: KeyRef; ease: CopiedKey["ease"] }[] = [];
    for (const k of keys) {
      const time = frameTime(frame + k.offset, fps);
      if (k.path.section === "events") {
        const name = String(k.fields.name);
        const has = (s.animations!.find((a) => a.name === animation)!.events ?? []).some((e) => e.name === name && sameTime(keyTime(e), time));
        if (!has) {
          const { name: _n, ...overrides } = k.fields;
          s = keyEvent(animation, time, name, overrides as Parameters<typeof keyEvent>[3])(s);
        }
        continue;
      }
      // Replaced whole: the key there goes first.
      const there = keysAt(s.animations!.find((a) => a.name === animation)!, k.path)?.some((x) => sameTime(keyTime(x), time));
      if (there) s = deleteKeys(animation, [{ path: k.path, time }])(s);
      s = setKey(animation, k.path, time, k.fields)(s);
      placed.push({ ref: { path: k.path, time }, ease: k.ease });
    }
    // Eases once every key is in: each fitted to the interval it now opens.
    for (const p of placed) if (p.ease) s = setKeyCurve(animation, p.ref, p.ease)(s);
    return s;
  };
  return { edit, skipped };
}

export interface CopiedPose { readonly kind: "pose"; readonly bones: ReadonlyMap<string, LocalPose> }

const FIELDS = [["rotate", ["rotation"]], ["translate", ["x", "y"]], ["scale", ["scaleX", "scaleY"]], ["shear", ["shearX", "shearY"]]] as const;
const same = (a: number, b: number) => Math.abs(a - b) <= 1e-4;

/**
 * Paste a pose: in `animation` (keyed at `time`) each property of each bone the rig has whose
 * value differs from `now` (the pose there); with no animation, the setup pose set. The bones the
 * rig does not have are skipped.
 */
export function pastePose(pose: CopiedPose, animation: string | null, time: number, now: ReadonlyMap<string, LocalPose>): Edit<Skeleton> {
  return (s0) => {
    let s = s0, any = false;
    for (const [bone, local] of pose.bones) {
      const b = s.bones?.find((x) => x.name === bone);
      if (!b) continue;
      if (animation === null) {
        const patch: BonePatch = {};
        for (const k of ["x", "y", "rotation", "scaleX", "scaleY", "shearX", "shearY"] as const) {
          if (same(local[k], boneNumber(b, k))) continue;
          patch[k] = same(local[k], BONE_DEFAULTS[k]) ? undefined : local[k];
          any = true;
        }
        if (Object.keys(patch).length) s = updateBone(bone, patch)(s);
        continue;
      }
      const cur = now.get(bone);
      const props: BoneProperty[] = FIELDS.filter(([, fs]) => !cur || fs.some((f) => !same(local[f], cur[f]))).map(([p]) => p);
      if (props.length) { s = keyBone(animation, bone, props, local, time)(s); any = true; }
    }
    if (!any) throw new EditRefused("The pose is already there: nothing to paste.");
    return s;
  };
}
