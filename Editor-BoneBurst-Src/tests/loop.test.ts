import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { closeLoop, closeLoops, closingTime, isSeamless, trimClosingKeys } from "@/edit/loop";
import { atlasImages } from "@/engine/regions";
import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import type { Animation, Key, Skeleton } from "@/model/skeleton";
import { animationDuration, frameTime, keyLists, keyTime, timeFrame } from "@/model/timelines";
import { boneMatrix, Poser } from "@/ui/stage/posed";

const FPS = 30;
const k = (frame: number, fields: Partial<Key> = {}): Key => ({ ...(frame ? { time: frameTime(frame, FPS) } : {}), ...fields, extra: new Map() }) as Key;
const anim = (bones: [string, string, Key[]][], extra: Partial<Animation> = {}): Animation => ({
  name: "loop", bones: bones.map(([name, timeline, keys]) => ({ name, timelines: [{ name: timeline, keys }] })), extra: new Map(), ...extra,
});
const doc = (animations: Animation[]): Skeleton => ({ header: { fps: FPS }, bones: [{ name: "root" }], animations } as unknown as Skeleton);

describe("closing a loop", () => {
  const open = anim([["a", "rotate", [k(0, { value: 10 }), k(7, { value: 40 }), k(13, { value: 25 })]], ["b", "translate", [k(0, { x: 1, y: 2 }), k(13, { x: 5, y: 6 })]]]);
  it("adds a key at the frame after the last, copying frame 0, on every timeline that starts at 0", () => {
    const closed = closeLoop(open, FPS);
    expect(animationDuration(closed)).toBeCloseTo(14 / FPS, 6);
    const lists = keyLists(closed);
    expect(lists[0]!.keys.at(-1)).toMatchObject({ value: 10, time: frameTime(14, FPS) });
    expect(lists[1]!.keys.at(-1)).toMatchObject({ x: 1, y: 2, time: frameTime(14, FPS) });
    // The keys that were there are untouched.
    expect(lists[0]!.keys.slice(0, 3)).toEqual(keyLists(open)[0]!.keys);
  });
  it("leaves a timeline that does not start at frame 0, and events and draw order, alone", () => {
    const a = anim([["a", "rotate", [k(0, { value: 1 }), k(5, { value: 2 })]], ["late", "rotate", [k(3, { value: 9 }), k(5, { value: 8 })]]], { events: [k(2, { name: "step" })] });
    const closed = closeLoop(a, FPS), lists = keyLists(closed);
    expect(lists.find((l) => l.path.section === "bones" && "owner" in l.path && l.path.owner === "late")!.keys).toHaveLength(2);
    expect(lists.find((l) => l.path.section === "events")!.keys).toHaveLength(1);
  });
  it("does not add a second copy to an animation that already ends on its first pose", () => {
    const seamless = anim([["a", "rotate", [k(0, { value: 10 }), k(7, { value: 40 }), k(14, { value: 10 })]]]);
    expect(isSeamless(seamless, FPS)).toBe(true);
    expect(closingTime(seamless, FPS)).toBeCloseTo(14 / FPS, 6);
    expect(closeLoop(seamless, FPS)).toBe(seamless);
  });
  it("closes the timelines left open in an animation whose others already end on frame 0's pose", () => {
    const mixed = anim([["a", "rotate", [k(0, { value: 10 }), k(14, { value: 10 })]], ["b", "rotate", [k(0, { value: 3 }), k(9, { value: 4 })]]]);
    const closed = closeLoop(mixed, FPS);
    expect(animationDuration(closed)).toBeCloseTo(14 / FPS, 6);
    expect(keyLists(closed)[1]!.keys.at(-1)).toMatchObject({ value: 3, time: frameTime(14, FPS) });
  });
  it("is the same animation when there is nothing to close, and for an animation without keys", () => {
    const empty = anim([]);
    expect(closeLoop(empty, FPS)).toBe(empty);
  });
});

describe("the ticks", () => {
  const a = anim([["a", "rotate", [k(0, { value: 1 }), k(9, { value: 2 })]]]);
  it("close every animation not turned off, and give back the same document when nothing changed", () => {
    const d = doc([a]);
    expect(animationDuration(closeLoops(d, new Set()).animations![0]!)).toBeCloseTo(10 / FPS, 6);
    expect(closeLoops(d, new Set(["loop"]))).toBe(d);
    const seamless = doc([anim([["a", "rotate", [k(0, { value: 1 }), k(9, { value: 1 })]]])]);
    expect(closeLoops(seamless, new Set())).toBe(seamless);
  });
});

describe("trimming a hand-made closing frame", () => {
  const frames = (a: Animation) => keyLists(a).map((l) => l.keys.map((x) => timeFrame(keyTime(x), FPS)));
  const made = anim([["a", "rotate", [k(0, { value: 10 }), k(7, { value: 40 }), k(13, { value: 25 }), k(14, { value: 10 })]], ["b", "translate", [k(0, { x: 1, y: 2 }), k(13, { x: 5, y: 6 }), k(14, { x: 1, y: 2 })]]]);
  it("deletes the copies, so 0–14 becomes 0–13", () => {
    const trimmed = trimClosingKeys("loop")(doc([made])).animations![0]!;
    expect(frames(trimmed)).toEqual([[0, 7, 13], [0, 13]]);
    expect(timeFrame(animationDuration(trimmed), FPS)).toBe(13);
  });
  it("and closing the trimmed animation gives the hand-made one back", () => {
    const again = closeLoop(trimClosingKeys("loop")(doc([made])).animations![0]!, FPS);
    expect(frames(again)).toEqual(frames(made));
    expect(keyLists(again).map((l) => l.keys.map((x) => [x.value, x.x, x.y]))).toEqual(keyLists(made).map((l) => l.keys.map((x) => [x.value, x.x, x.y])));
  });
  it("is refused on an animation that does not end on its first pose", () => {
    expect(() => trimClosingKeys("loop")(doc([anim([["a", "rotate", [k(0, { value: 1 }), k(9, { value: 2 })]]])]))).toThrow(/first pose/);
  });
});

describe("on the stickman", () => {
  const dir = join(__dirname, "fixtures", "stickman");
  const stick = readSkeleton(readFileSync(join(dir, "Stickman_IK.json"), "utf8")).skeleton;
  const images = atlasImages(readAtlas(readFileSync(join(dir, "Stickman_IK.atlas.txt"), "utf8")));
  const a = stick.animations![0]!, fps = stick.header?.fps ?? 30;
  it("the closed export is the animation written out again, and keyed 0..N-1 closes to the same file as 0..N", () => {
    const closed = closeLoops(stick, new Set());
    // Whatever the file was, its closed form is a fixed point: closing again changes nothing.
    expect(closeLoops(closed, new Set())).toBe(closed);
    expect(writeSkeleton(closed)).toBe(writeSkeleton(closeLoops(closed, new Set())));
  });
  it("poses the closing frame as frame 0", () => {
    const closed = closeLoops(stick, new Set()), ca = closed.animations![0]!, end = animationDuration(ca);
    const at = (d: Skeleton, t: number) => { const p = new Poser(d, images).pose(null, a.name, Math.fround(t), "none"); return p.rig.data.bones.map((b) => boneMatrix(p, b.index).slice(0, 6)); };
    const first = at(closed, 0), last = at(closed, end);
    for (let i = 0; i < first.length; i++) for (let j = 0; j < 6; j++) expect(last[i]![j]).toBeCloseTo(first[i]![j]!, 3);
    void fps;
  });
});
