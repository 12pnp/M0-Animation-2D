import type { ConstraintType, Skeleton } from "@/model/skeleton";
import type { TimelinePath } from "@/model/timelines";
import type { ConstraintRef } from "./constraints";
import { EditRefused, type Edit } from "./history";
import { type KeyFields, setKey } from "./keys";

/**
 * Keying a constraint's animatable values at a time (E4-PLAN step 11; Format-Json-Atlas.md
 * §11.5–11.9). A key holds the pose at the playhead: the caller gives every value of the key's
 * timeline as it is there, and the one changed; values at their key default are left out.
 */

export type ConstraintValues = Readonly<Record<string, number | boolean>>;

/** Per kind, each keyable field: the timeline it keys (null: the constraint's own key list) and the fields that key holds. */
export const CONSTRAINT_KEYS: { readonly [K in ConstraintType]: Readonly<Record<string, { readonly timeline: string | null; readonly fields: readonly string[] }>> } = (() => {
  const all = <F extends string>(fields: readonly F[], timeline: string | null) => Object.fromEntries(fields.map((f) => [f, { timeline, fields }]));
  const own = (f: string, timeline = f) => ({ [f]: { timeline, fields: ["value"] } });
  return {
    ik: all(["mix", "softness", "bendPositive", "compress", "stretch"], null),
    transform: all(["mixRotate", "mixX", "mixY", "mixScaleX", "mixScaleY", "mixShearY"], null),
    path: { ...own("position"), ...own("spacing"), ...all(["mixRotate", "mixX", "mixY"], "mix") },
    physics: Object.assign({}, ...["inertia", "strength", "damping", "mass", "wind", "gravity", "mix"].map((f) => own(f))),
    slider: { ...own("time"), ...own("mix") },
  };
})();

/** What a key's field means when left out (§11.5–11.9); a function of the key for the defaults that follow another field. */
function keyDefault(type: ConstraintType, timeline: string | null, field: string, key: Record<string, unknown>): unknown {
  switch (type) {
    case "ik": return ({ mix: 1, softness: 0, bendPositive: true, compress: false, stretch: false } as Record<string, unknown>)[field];
    case "transform": return field === "mixY" ? key.mixX ?? 1 : 1;
    case "path": return timeline === "mix" ? (field === "mixY" ? key.mixX ?? 1 : 1) : 0;
    case "physics": return timeline === "mix" ? 1 : 0;
    // A slider's time key without a value is 1, as is its mix (§11.9).
    case "slider": return 1;
  }
}

/**
 * Key `field` of the constraint to `value` at `time`, the key's other fields at `now` (the
 * animated values at the playhead). Refused for a field that does not animate.
 */
export function keyConstraint(animation: string, r: ConstraintRef, field: string, value: number | boolean, now: ConstraintValues, time: number): Edit<Skeleton> {
  return (s) => {
    if (!s.constraints?.some((c) => c.type === r.type && c.name === r.name)) throw new EditRefused(`There is no such constraint: "${r.name}".`);
    const spec = CONSTRAINT_KEYS[r.type][field];
    if (!spec) throw new EditRefused(`${field} is part of the setup pose; it does not animate.`);
    const path: TimelinePath = spec.timeline === null
      ? { section: r.type as "ik" | "transform", owner: r.name }
      : { section: r.type as "path" | "physics" | "slider", owner: r.name, timeline: spec.timeline };
    const full: Record<string, unknown> = {};
    for (const f of spec.fields) {
      const source = f === "value" ? field : f;
      full[f] = source === field ? value : now[source];
      if (full[f] === undefined) throw new EditRefused(`The value of ${source} at the playhead is not known.`);
    }
    // Defaults left out; those following another field are judged after it is settled.
    const fields: Record<string, unknown> = {}, clear: string[] = [];
    for (const f of spec.fields) {
      const v = typeof full[f] === "number" ? Math.round((full[f] as number) * 1e4) / 1e4 : full[f];
      if (v === keyDefault(r.type, spec.timeline, f === "value" ? field : f, full)) clear.push(f);
      else fields[f] = v;
    }
    return setKey(animation, path, time, fields as KeyFields, clear as (keyof KeyFields)[])(s);
  };
}

/** A physics Reset key at `time`: the simulation starts over there. */
export function keyPhysicsReset(animation: string, name: string, time: number): Edit<Skeleton> {
  return (s) => {
    if (!s.constraints?.some((c) => c.type === "physics" && c.name === name)) throw new EditRefused(`There is no physics constraint "${name}".`);
    return setKey(animation, { section: "physics", owner: name, timeline: "reset" }, time, {})(s);
  };
}
