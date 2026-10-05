import type { ItemId, NodeId } from "./ids";
import type { Animation, ImageItem, Project, SequenceData, SequenceKey, SequenceMode } from "./types";
import { isImage } from "./types";

/**
 * Sequences (ARCHITECTURE ▸ Sequences), pure: frame-by-frame images in one
 * display, as Spine's region sequence, and the keys that pick the image
 * (Spine's sequence timeline). The index rule is `SequenceTimeline.apply`'s
 * in spine-core 4.3, with the delay in frames: the export divides both the
 * time and the delay by the frame rate, so the ratio is the same.
 */

export const SEQUENCE_MODES: readonly SequenceMode[] = ["hold", "once", "loop", "pingpong", "onceReverse", "loopReverse", "pingpongReverse"];

export const SEQUENCE_MODE_LABELS: Record<SequenceMode, string> = {
  hold: "Hold", once: "Once", loop: "Loop", pingpong: "Ping-pong",
  onceReverse: "Once, reversed", loopReverse: "Loop, reversed", pingpongReverse: "Ping-pong, reversed",
};

/** The image a sequence of `count` shows at `frame`: the setup one before
 *  the first key, else the key's index advanced by its mode. */
export function sequenceIndexAt(keys: readonly SequenceKey[] | undefined, frame: number, count: number, setup = 0): number {
  const clamp = (i: number) => Math.max(0, Math.min(count - 1, i));
  if (!keys?.length || frame < keys[0]!.frame) return clamp(setup);
  let k = keys[0]!;
  for (const key of keys) if (key.frame <= frame) k = key;
  let index = k.index;
  if (k.mode !== "hold" && k.delay > 0) {
    index += Math.floor((frame - k.frame) / k.delay + 0.00001);
    switch (k.mode) {
      case "once": index = Math.min(count - 1, index); break;
      case "loop": index %= count; break;
      case "pingpong": {
        const n = count * 2 - 2;
        index = n === 0 ? 0 : index % n;
        if (index >= count) index = n - index;
        break;
      }
      case "onceReverse": index = Math.max(count - 1 - index, 0); break;
      case "loopReverse": index = count - 1 - (index % count); break;
      case "pingpongReverse": {
        const n = count * 2 - 2;
        index = n === 0 ? 0 : (index + count - 1) % n;
        if (index >= count) index = n - index;
      }
    }
  }
  return clamp(index);
}

/** The image a node's display 0 sequence shows at `frame` of `anim`. */
export function sequenceItemAt(seq: SequenceData, anim: Animation | null | undefined, nodeId: NodeId, frame: number): ItemId {
  return seq.items[sequenceIndexAt(anim?.sequences?.[nodeId], frame, seq.items.length, seq.setup)]!;
}

/** How the export names a sequence's regions: `path` + the number, zero
 *  padded to `digits`, from `start`. Null when the names do not run so. */
export function sequenceNaming(names: readonly string[]): { path: string; start: number; digits: number } | null {
  const first = names.length ? /^(.*?)(\d+)$/.exec(names[0]!) : null;
  if (!first) return null;
  const path = first[1]!, start = Number(first[2]);
  // Spine pads to `digits` (`Sequence.getPath`); a leading zero says how many.
  const digits = first[2]!.length > 1 && first[2]!.startsWith("0") ? first[2]!.length : 0;
  return names.every((n, i) => n === path + String(start + i).padStart(digits, "0")) ? { path, start, digits } : null;
}

/**
 * The sequence an image starts (Spine's "sequence import from numbered
 * images"): the library images named like it with the numbers that follow,
 * run on from the lowest; all must be its size. A reason when there is none.
 */
export function sequenceFor(project: Project, itemId: ItemId): SequenceData | string {
  const item = project.items[itemId];
  if (!isImage(item)) return "A sequence is made of images.";
  const m = /^(.*?)(\d+)$/.exec(item.name);
  if (!m) return `"${item.name}" does not end in a number; name the frames like fire_01, fire_02, ….`;
  const prefix = m[1]!;
  const byNumber = new Map<number, ImageItem>();
  for (const i of Object.values(project.items)) {
    if (!isImage(i)) continue;
    const n = /^(.*?)(\d+)$/.exec(i.name);
    if (n && n[1] === prefix) byNumber.set(Number(n[2]), i);
  }
  let first = Number(m[2]);
  while (byNumber.has(first - 1)) first--;
  const run: ImageItem[] = [];
  for (let n = first; byNumber.has(n); n++) run.push(byNumber.get(n)!);
  if (run.length < 2) return `There is no "${prefix}" image numbered next to "${item.name}" in the library.`;
  const odd = run.find((i) => i.width !== run[0]!.width || i.height !== run[0]!.height);
  if (odd) return `"${odd.name}" is ${odd.width}×${odd.height}, the others ${run[0]!.width}×${run[0]!.height}: a sequence's images are all one size.`;
  if (!sequenceNaming(run.map((i) => i.name))) return `"${prefix}" images are not numbered one after another with the same padding.`;
  return { items: run.map((i) => i.id), setup: run.indexOf(item) };
}

/** `keys` with a key at `frame`; one there is replaced. */
export function withSequenceKey(keys: readonly SequenceKey[], key: SequenceKey): SequenceKey[] {
  return [...keys.filter((k) => k.frame !== key.frame), key].sort((a, b) => a.frame - b.frame);
}

/** The keys at `frames` moved by `delta` frames (not before 0), replacing
 *  keys they land on. */
export function moveKeys<K extends { frame: number }>(keys: readonly K[], frames: readonly number[], delta: number): K[] {
  const moving = new Set(frames);
  const moved = new Map<number, K>();
  for (const k of keys) if (moving.has(k.frame)) moved.set(Math.max(0, k.frame + delta), { ...k, frame: Math.max(0, k.frame + delta) });
  return [...keys.filter((k) => !moving.has(k.frame) && !moved.has(k.frame)), ...moved.values()].sort((a, b) => a.frame - b.frame);
}
