import type { Json } from "@/model/json";
import type { Guide, MotionPath, Reference, Sidecar } from "@/model/sidecar";
import { EditRefused } from "./history";

/**
 * Sidecar edits (E4-PLAN step 8): guides and the view. Pure, like document edits, but not undo
 * steps: the sidecar is not the document (SPEC §3).
 */

const at2 = (n: number) => { const v = Math.round(n * 100) / 100; return v === 0 ? 0 : v; };

export function addGuide(s: Sidecar, axis: Guide["axis"], at: number): Sidecar {
  return { ...s, guides: [...s.guides, { axis, at: at2(at) }] };
}

export function moveGuide(s: Sidecar, i: number, at: number): Sidecar {
  const g = s.guides[i];
  if (!g || g.at === at2(at)) return s;
  return { ...s, guides: s.guides.map((x, n) => (n === i ? { ...x, at: at2(at) } : x)) };
}

export function removeGuide(s: Sidecar, i: number): Sidecar {
  if (!s.guides[i]) return s;
  return { ...s, guides: s.guides.filter((_, n) => n !== i) };
}

/** What the view keeps of the stage: where it looks, how close, which skin and animation, and the selected bone. */
export interface View {
  readonly camera?: { readonly x: number; readonly y: number; readonly zoom: number };
  readonly skin?: string;
  readonly animation?: string;
  readonly bone?: string;
  /** The animations whose Loop tick is off (docs/LOOP-PLAN.md): every other one is a loop. */
  readonly loopOff?: readonly string[];
}

/** The sidecar with `view` written over the keys it names; other view keys (a newer editor's) kept. */
export function withView(s: Sidecar, view: View): Sidecar {
  const out = new Map<string, Json>(s.view);
  for (const k of ["camera", "skin", "animation", "bone", "loopOff"]) out.delete(k);
  if (view.camera) out.set("camera", new Map<string, Json>([["x", at2(view.camera.x)], ["y", at2(view.camera.y)], ["zoom", Math.round(view.camera.zoom * 1e4) / 1e4]]));
  if (view.skin !== undefined) out.set("skin", view.skin);
  if (view.animation !== undefined) out.set("animation", view.animation);
  if (view.bone !== undefined) out.set("bone", view.bone);
  if (view.loopOff?.length) out.set("loopOff", [...view.loopOff]);
  return { ...s, view: out };
}

/** The view a sidecar keeps, with what does not read left out. */
export function viewOf(s: Sidecar): View {
  const cam = s.view.get("camera"), skin = s.view.get("skin"), animation = s.view.get("animation"), bone = s.view.get("bone"), loopOff = s.view.get("loopOff");
  const num = (o: unknown, k: string) => (o instanceof Map && typeof o.get(k) === "number" ? (o.get(k) as number) : undefined);
  const x = num(cam, "x"), y = num(cam, "y"), zoom = num(cam, "zoom");
  return {
    ...(x !== undefined && y !== undefined && zoom !== undefined && zoom > 0 ? { camera: { x, y, zoom } } : {}),
    ...(typeof skin === "string" ? { skin } : {}),
    ...(typeof animation === "string" ? { animation } : {}),
    ...(typeof bone === "string" ? { bone } : {}),
    ...(Array.isArray(loopOff) && loopOff.every((n) => typeof n === "string") && loopOff.length ? { loopOff: loopOff as string[] } : {}),
  };
}

/** Whether a sidecar holds anything a person made (the view alone does not count). */
export const hasContent = (s: Sidecar) => s.guides.length > 0 || s.references.length > 0 || s.notes.length > 0 || s.motion.length > 0 || s.tags.length > 0;

/** The motion path kept for `bone` in `animation`, or undefined. */
export function motionOf(s: Sidecar, animation: string, bone: string): MotionPath | undefined {
  return s.motion.find((m) => m.animation === animation && m.bone === bone);
}

/** The sidecar with `m` kept for its bone and animation (replacing the one there), or, with null, that path dropped. */
export function withMotion(s: Sidecar, animation: string, bone: string, m: MotionPath | null): Sidecar {
  const rest = s.motion.filter((x) => !(x.animation === animation && x.bone === bone));
  const motion = m ? [...rest, m] : rest;
  return motion.length === s.motion.length && m === null ? s : { ...s, motion };
}

/** The fields of a reference an edit may set. */
export type ReferencePatch = { -readonly [K in Exclude<keyof Reference, "path">]?: Reference[K] };

function checkReference(r: Reference): Reference {
  if (!(r.scale > 0) || !Number.isFinite(r.scale)) throw new EditRefused("A reference's scale is above 0.");
  if (!(r.opacity >= 0 && r.opacity <= 1)) throw new EditRefused("Opacity is from 0 to 1.");
  if (!Number.isFinite(r.x) || !Number.isFinite(r.y)) throw new EditRefused("A reference's place is a number.");
  return { ...r, x: at2(r.x), y: at2(r.y) };
}

/** Add a reference image, last (drawn last of the references, still behind the skeleton). */
export function addReference(s: Sidecar, r: Reference): Sidecar {
  if (!r.path.trim()) throw new EditRefused("A reference needs its image's file name.");
  return { ...s, references: [...s.references, checkReference(r)] };
}

export function updateReference(s: Sidecar, i: number, patch: ReferencePatch): Sidecar {
  const r = s.references[i];
  if (!r) return s;
  const next = checkReference({ ...r, ...patch });
  if (next.x === r.x && next.y === r.y && next.scale === r.scale && next.opacity === r.opacity) return s;
  return { ...s, references: s.references.map((x, n) => (n === i ? next : x)) };
}

export function removeReference(s: Sidecar, i: number): Sidecar {
  if (!s.references[i]) return s;
  return { ...s, references: s.references.filter((_, n) => n !== i) };
}

/** Move reference `i` to index `to` (drawn in list order). */
export function moveReference(s: Sidecar, i: number, to: number): Sidecar {
  const list = s.references, j = Math.max(0, Math.min(list.length - 1, to));
  if (!list[i] || i === j) return s;
  const rest = list.filter((_, n) => n !== i);
  return { ...s, references: [...rest.slice(0, j), list[i]!, ...rest.slice(j)] };
}
