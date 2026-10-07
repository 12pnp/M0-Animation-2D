import type { Animation, Key, Skeleton } from "@/model/skeleton";
import { animationDuration, DEFAULT_FPS, frameTime, keyLists, keyTime, type PathKeys, timeFrame } from "@/model/timelines";
import { EditRefused, type Edit } from "./history";
import { deleteKeys, type KeyRef, sameTime, withKeys } from "./keys";

/**
 * Loop animations (docs/LOOP-PLAN.md). A loop ends on the pose it began with, so the animation is
 * keyed 0–13 and the closing key, frame 14 = frame 0, is supplied where the animation is *used*
 * (posed, played, exported), never stored in the document being edited.
 */

/** A timeline that closes: one with a key at frame 0 (events and draw order do not). */
function closes(l: PathKeys): boolean {
  const s = l.path.section;
  return s !== "events" && s !== "drawOrder" && l.keys.length > 0 && sameTime(keyTime(l.keys[0]!), 0);
}

/** Two keys name the same pose: every field but time and curve (the curve is the way to the next key). */
function samePose(a: Key, b: Key): boolean {
  const x = a as unknown as Record<string, unknown>, y = b as unknown as Record<string, unknown>;
  const names = new Set([...Object.keys(x), ...Object.keys(y)].filter((k) => k !== "time" && k !== "curve" && k !== "extra"));
  for (const k of names) if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) return false;
  return true;
}

/** Whether a list already ends where it began, at the animation's end. */
function closedAt(l: PathKeys, end: number): boolean {
  const last = l.keys.at(-1)!;
  return l.keys.length > 1 && sameTime(keyTime(last), end) && samePose(last, l.keys[0]!);
}

/**
 * The time the animation's closing key goes at: its end when some timeline already ends on its first
 * pose there (a hand-made 0–14), else one frame after its last key.
 */
export function closingTime(a: Animation, fps: number): number {
  const end = animationDuration(a), lists = keyLists(a).filter(closes);
  return lists.some((l) => closedAt(l, end)) ? end : frameTime(timeFrame(end, fps) + 1, fps);
}

/**
 * `a` with every timeline that starts at frame 0 closed: a key at the closing time copying frame 0.
 * A timeline that already has a key there is left as it is. The same animation when nothing needs
 * adding, so a cache keyed on it holds.
 */
export function closeLoop(a: Animation, fps: number): Animation {
  const at = closingTime(a, fps);
  let out = a;
  for (const l of keyLists(a).filter(closes)) {
    if (l.keys.some((k) => sameTime(keyTime(k), at))) continue;
    const { time: _t, curve: _c, ...first } = l.keys[0]!;
    out = withKeys(out, l.path, [...l.keys, { ...first, time: at } as Key]);
  }
  return out;
}

/** Whether the animation already ends on its first pose, on every timeline that starts at frame 0. */
export function isSeamless(a: Animation, fps: number): boolean {
  const end = animationDuration(a), lists = keyLists(a).filter(closes);
  void fps;
  return lists.length > 0 && lists.every((l) => closedAt(l, end));
}

/** The document with the animations not in `off` closed: what is posed, played and exported. The same document when nothing changed. */
export function closeLoops(doc: Skeleton, off: ReadonlySet<string>): Skeleton {
  const fps = doc.header?.fps ?? DEFAULT_FPS;
  const list = doc.animations;
  if (!list?.length) return doc;
  const next = list.map((a) => (off.has(a.name) ? a : closeLoop(a, fps)));
  return next.every((a, i) => a === list[i]) ? doc : { ...doc, animations: next };
}

/** Delete the closing keys of a seamless animation (every timeline's last key, a copy of its first): 0–14 becomes 0–13. */
export function trimClosingKeys(animation: string): Edit<Skeleton> {
  return (s) => {
    const a = s.animations?.find((x) => x.name === animation);
    if (!a) throw new EditRefused(`There is no animation "${animation}".`);
    const fps = s.header?.fps ?? DEFAULT_FPS;
    if (!isSeamless(a, fps)) throw new EditRefused(`"${animation}" does not end on its first pose, so there is no closing frame to trim.`);
    const end = animationDuration(a);
    const refs: KeyRef[] = keyLists(a).filter(closes).filter((l) => closedAt(l, end)).map((l) => ({ path: l.path, time: keyTime(l.keys.at(-1)!) }));
    return deleteKeys(animation, refs)(s);
  };
}
