import { frameTime, keyLists, keyTime, timeFrame } from "@/model/timelines";
import type { Session } from "../session";
import type { AtlasImages } from "@/engine/regions";
import type { Skeleton } from "@/model/skeleton";
import { type Posed, Poser } from "./posed";

/**
 * Onion skin (E6-PLAN step 4d): the poses at frames near the playhead, drawn faint behind the
 * skeleton. Which frames is pure (`onionFrames`, tested); the ghosts are posed by a poser of
 * their own, so the pose shown is not disturbed.
 */

export interface OnionOptions {
  readonly before: number;
  readonly after: number;
  /** Only frames with keys (any of the animation's), not every frame. */
  readonly keyedOnly: boolean;
  /** Past red, future green, as silhouettes; else the images, faded. */
  readonly colour: boolean;
}

export interface OnionFrame { readonly frame: number; readonly side: "before" | "after"; readonly opacity: number }

/** The strongest ghost's opacity; each further one fades towards none. */
const NEAREST = 0.45;

/**
 * The ghost frames around `frame` in an animation of `end` frames: `before` and `after` of them,
 * every frame or only `keyed` ones; past either end they wrap round when `loop`, else stop.
 * Nearer ghosts are stronger. The playhead's own frame is never a ghost.
 */
export function onionFrames(frame: number, end: number, o: Pick<OnionOptions, "before" | "after" | "keyedOnly">, keyed: readonly number[], loop: boolean): OnionFrame[] {
  const out: OnionFrame[] = [];
  const fade = (k: number, n: number) => NEAREST * (n + 1 - k) / n;
  const wrap = (f: number) => (end > 0 ? ((f % end) + end) % end : f);
  const pick = (side: "before" | "after", n: number) => {
    const dir = side === "before" ? -1 : 1, seen = new Set<number>([frame]);
    if (o.keyedOnly) {
      const sorted = [...new Set(keyed)].sort((a, b) => a - b);
      let list = side === "before" ? sorted.filter((f) => f < frame).reverse() : sorted.filter((f) => f > frame);
      if (loop && end > 0 && list.length < n) list = [...list, ...(side === "before" ? sorted.slice().reverse() : sorted).filter((f) => f !== frame && !list.includes(f))];
      list.slice(0, n).forEach((f, i) => out.push({ frame: f, side, opacity: fade(i + 1, n) }));
      return;
    }
    for (let k = 1; k <= n; k++) {
      let f = frame + dir * k;
      if (f < 0 || f > end) { if (!loop || end <= 0) break; f = wrap(f); }
      if (seen.has(f)) continue;
      seen.add(f);
      out.push({ frame: f, side, opacity: fade(k, n) });
    }
  };
  if (o.before > 0) pick("before", o.before);
  if (o.after > 0) pick("after", o.after);
  return out;
}

/** A ghost as the renderer draws it: posed when it is its turn, in a colour (null: its own) at an opacity. */
export interface Ghost { readonly pose: () => Posed | null; readonly colour: readonly [number, number, number] | null; readonly opacity: number }

const PAST: readonly [number, number, number] = [0.9, 0.25, 0.2];
const FUTURE: readonly [number, number, number] = [0.2, 0.7, 0.3];

/** The ghosts' own poser: built once per document and atlas. */
let cached: { doc: Skeleton; images: AtlasImages; poser: Poser } | null = null;
function ghostPoser(doc: Skeleton, images: AtlasImages): Poser {
  if (cached?.doc !== doc || cached.images !== images) cached = { doc, images, poser: new Poser(doc, images) };
  return cached.poser;
}

/** The ghosts to draw now: none without an animation, while playing, or with onion skin off. */
export function ghostsFor(session: Session, o: OnionOptions | null): Ghost[] {
  const a = session.animation, doc = session.closedDoc();
  if (!o || !a || !doc || session.playing) return [];
  const fps = session.fps, end = timeFrame(session.length(a), fps);
  const keyed = o.keyedOnly ? keyLists(a).flatMap((l) => l.keys.map((k) => timeFrame(keyTime(k), fps))) : [];
  const frames = onionFrames(session.frame, end, o, keyed, session.loop);
  // Farthest first, so nearer ghosts lie over them.
  frames.sort((x, y) => x.opacity - y.opacity);
  return frames.map((f) => ({
    pose: () => ghostPoser(doc, session.images).pose(session.skin, a.name, Math.fround(frameTime(f.frame, fps))),
    colour: o.colour ? (f.side === "before" ? PAST : FUTURE) : null,
    opacity: f.opacity,
  }));
}
