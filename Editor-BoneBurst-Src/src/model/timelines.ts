import type { Animation, Key, KeyList, TimelineGroup } from "./skeleton";

/**
 * An animation's key lists, addressed one by one, and what their keys mean as curve channels
 * (Format-Json-Atlas.md §11–12). Pure queries; the edits are `edit/keys.ts`.
 */

/** Where one key list sits in an animation. */
export type TimelinePath =
  | { readonly section: "bones" | "slots" | "path" | "physics" | "slider"; readonly owner: string; readonly timeline: string }
  | { readonly section: "ik" | "transform"; readonly owner: string }
  | { readonly section: "attachments"; readonly skin: string; readonly slot: string; readonly attachment: string; readonly timeline: string }
  | { readonly section: "drawOrder" | "events" };

export type GroupSection = "bones" | "slots" | "path" | "physics" | "slider";
export const GROUP_SECTIONS: readonly GroupSection[] = ["slots", "bones", "path", "physics", "slider"];

export interface PathKeys { readonly path: TimelinePath; readonly keys: readonly Key[] }

/** A stable text for a path: selection and row identity. */
export function pathId(p: TimelinePath): string {
  switch (p.section) {
    case "ik": case "transform": return `${p.section}/${p.owner}`;
    case "attachments": return `attachments/${p.skin}/${p.slot}/${p.attachment}/${p.timeline}`;
    case "drawOrder": case "events": return p.section;
    default: return `${p.section}/${p.owner}/${p.timeline}`;
  }
}

/** Every key list of the animation, in the reader's order (§11.1). */
export function keyLists(a: Animation): PathKeys[] {
  const out: PathKeys[] = [];
  const groups = (section: GroupSection, gs: readonly TimelineGroup[] | undefined) => {
    for (const g of gs ?? []) for (const t of g.timelines) out.push({ path: { section, owner: g.name, timeline: t.name }, keys: t.keys });
  };
  const lists = (section: "ik" | "transform", ls: readonly KeyList[] | undefined) => {
    for (const l of ls ?? []) out.push({ path: { section, owner: l.name }, keys: l.keys });
  };
  groups("slots", a.slots);
  groups("bones", a.bones);
  lists("ik", a.ik);
  lists("transform", a.transform);
  groups("path", a.path);
  groups("physics", a.physics);
  groups("slider", a.slider);
  for (const sk of a.attachments ?? []) {
    for (const sl of sk.slots) {
      for (const at of sl.attachments) {
        for (const t of at.timelines) out.push({ path: { section: "attachments", skin: sk.skin, slot: sl.slot, attachment: at.name, timeline: t.name }, keys: t.keys });
      }
    }
  }
  if (a.drawOrder) out.push({ path: { section: "drawOrder" }, keys: a.drawOrder });
  if (a.events) out.push({ path: { section: "events" }, keys: a.events });
  return out;
}

/** The key list at `p`, or undefined when the animation has none there. */
export function keysAt(a: Animation, p: TimelinePath): readonly Key[] | undefined {
  const id = pathId(p);
  return keyLists(a).find((k) => pathId(k.path) === id)?.keys;
}

export function keyTime(k: Key): number {
  return k.time ?? 0;
}

/** The animation's length in seconds: the latest last key of any list (§11.1). */
export function animationDuration(a: Animation): number {
  let d = 0;
  for (const { keys } of keyLists(a)) { const last = keys.at(-1); if (last) d = Math.max(d, keyTime(last)); }
  for (const f of a.drawOrderFolder ?? []) { const last = f.keys?.at(-1); if (last) d = Math.max(d, keyTime(last)); }
  return d;
}

export const DEFAULT_FPS = 30;

/**
 * The time Spine writes for frame `frame` at `fps`: the shortest decimal that reads back as the
 * same float32 as frame / fps (frame 4 at 30 is 0.13333334).
 */
export function frameTime(frame: number, fps: number): number {
  return shortFloat(frame / fps);
}

/** `n` as the Spine Editor writes numbers: the shortest decimal that reads back as the same float32. */
export function shortFloat(n: number): number {
  const f = Math.fround(n);
  if (Number.isInteger(f) || !Number.isFinite(f)) return f === 0 ? 0 : f;
  for (let p = 1; p <= 9; p++) {
    const s = Number(f.toPrecision(p));
    if (Math.fround(s) === f) return s;
  }
  return f;
}

/** The frame a time falls on at `fps`. */
export function timeFrame(time: number, fps: number): number {
  return Math.round(time * fps);
}

/** How many curve channels a key list's keys have (§12.1); 0 for one without curves. */
export function channelCount(p: TimelinePath): number {
  switch (p.section) {
    case "bones": return ["translate", "scale", "shear"].includes(p.timeline) ? 2 : p.timeline === "inherit" ? 0 : 1;
    case "slots": return ({ rgba: 4, rgb: 3, alpha: 1, rgba2: 7, rgb2: 6 } as Record<string, number>)[p.timeline] ?? 0;
    case "ik": return 2;
    case "transform": return 6;
    case "path": return p.timeline === "mix" ? 3 : 1;
    case "physics": return p.timeline === "reset" ? 0 : 1;
    case "slider": return 1;
    case "attachments": return p.timeline === "deform" ? 1 : 0;
    default: return 0;
  }
}

/**
 * A key's channel values as its curve's handles are measured (§12.1), in the file's units,
 * defaults filled in (§11.3–11.9). Deform's one channel runs 0 → 1 across every interval:
 * `end` says which end of the interval the key is.
 */
export function channelValues(p: TimelinePath, k: Key, end: "start" | "end"): number[] {
  const v = (d: number) => k.value ?? d;
  switch (p.section) {
    case "bones":
      switch (p.timeline) {
        case "rotate": case "translatex": case "translatey": case "shearx": case "sheary": return [v(0)];
        case "scalex": case "scaley": return [v(1)];
        case "translate": case "shear": return [k.x ?? 0, k.y ?? 0];
        case "scale": return [k.x ?? 1, k.y ?? 1];
        default: return [];
      }
    case "slots":
      switch (p.timeline) {
        case "rgba": return rgba(k.color, 4);
        case "rgb": return rgba(k.color, 3);
        case "alpha": return [v(0)];
        case "rgba2": return [...rgba(k.light, 4), ...rgba(k.dark, 3)];
        case "rgb2": return [...rgba(k.light, 3), ...rgba(k.dark, 3)];
        default: return [];
      }
    case "ik": return [k.mix ?? 1, k.softness ?? 0];
    case "transform": {
      const x = k.mixX ?? 1;
      return [k.mixRotate ?? 1, x, k.mixY ?? x, k.mixScaleX ?? 1, k.mixScaleY ?? 1, k.mixShearY ?? 1];
    }
    case "path": {
      if (p.timeline !== "mix") return [v(0)];
      const x = k.mixX ?? 1;
      return [k.mixRotate ?? 1, x, k.mixY ?? x];
    }
    case "physics": return p.timeline === "reset" ? [] : [v(p.timeline === "mix" ? 1 : 0)];
    case "slider": return [v(1)];
    case "attachments": return p.timeline === "deform" ? [end === "start" ? 0 : 1] : [];
    default: return [];
  }
}

/** A hex colour's first `n` channels as 0..1 (absent or short: 1). */
function rgba(hex: string | undefined, n: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = hex?.slice(i * 2, i * 2 + 2);
    out.push(s && s.length === 2 ? parseInt(s, 16) / 255 : 1);
  }
  return out;
}
