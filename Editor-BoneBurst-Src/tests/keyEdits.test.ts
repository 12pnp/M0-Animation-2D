import { describe, expect, it } from "vitest";
import { addAnimation } from "@/edit/animations";
import { keyBone } from "@/edit/boneKeys";
import { PRESETS } from "@/edit/curves";
import { drawOrderAt, offsetsFor, reorderFront } from "@/edit/drawOrder";
import { defineEvent, deleteEvent, deleteEventKeys, keyEvent, renameEvent } from "@/edit/events";
import { EditRefused } from "@/edit/history";
import { setKey, setKeyCurve } from "@/edit/keys";
import { newSkeleton } from "@/edit/newSkeleton";
import { NO_IMAGES } from "@/engine/regions";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import type { Animation, Skeleton } from "@/model/skeleton";
import { animatedLocal, Poser } from "@/ui/stage/posed";

const pose0 = { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0 };
const translatePath = { section: "bones" as const, owner: "root", timeline: "translate" };
/** A root keyed from (0, 0) at 0 s to (100, 100) at 1 s. */
function moving(): Skeleton {
  let s = addAnimation("go")(newSkeleton("h"));
  s = keyBone("go", "root", ["translate"], pose0, 0)(s);
  return keyBone("go", "root", ["translate"], { ...pose0, x: 100, y: 100 }, 1)(s);
}
const keys = (s: Skeleton) => s.animations![0]!.bones![0]!.timelines[0]!.keys;
const refused = (f: () => unknown) => { try { f(); return ""; } catch (e) { expect(e).toBeInstanceOf(EditRefused); return (e as Error).message; } };

describe("key edits for the AI tools (E5 step 4)", () => {
  it("setKeyCurve shapes each channel on its own: x eases in, y stays straight, as the runtime plays it", () => {
    const s = setKeyCurve("go", { path: translatePath, time: 0 }, [PRESETS.easeIn, null])(moving());
    expect(keys(s)[0]!.curve).toHaveLength(8);
    const local = animatedLocal(new Poser(s, NO_IMAGES).pose(null, "go", 0.5), 0);
    expect(local.x).toBeLessThan(40);
    expect(local.y).toBeCloseTo(50, 3);
    // All straight is no curve; stepped is the whole key; the last key has no interval to shape.
    expect(keys(setKeyCurve("go", { path: translatePath, time: 0 }, [null, null])(s))[0]!.curve).toBeUndefined();
    expect(keys(setKeyCurve("go", { path: translatePath, time: 0 }, "stepped")(s))[0]!.curve).toBe("stepped");
    expect(keys(setKeyCurve("go", { path: translatePath, time: 1 }, [PRESETS.easeOut, null])(s))[1]!.curve).toBeUndefined();
    expect(refused(() => setKeyCurve("go", { path: translatePath, time: 0.5 }, "stepped")(s))).toMatch(/There is no key at 0.5s/);
  });
  it("draw order: the order in force at a time, and listed slots moved into their own places, front first", () => {
    const slots = ["a", "b", "c", "d", "e"];
    // b and d swap places, front first: d to the back of the two (b's place), b to the front (d's).
    expect(reorderFront(slots, ["b", "d"])).toEqual(["a", "d", "c", "b", "e"]);
    expect(reorderFront(slots, ["d", "b"])).toEqual(slots);
    expect(reorderFront(["e", "a", "b", "c", "d"], ["a", "e"])).toEqual(["e", "a", "b", "c", "d"]);
    expect(reorderFront(["e", "a", "b", "c", "d"], ["e", "a"])).toEqual(["a", "e", "b", "c", "d"]);
    let s: Skeleton = { ...addAnimation("go")(newSkeleton("h")), slots: slots.map((name) => ({ name, bone: "root", extra: new Map() })) };
    s = setKey("go", { section: "drawOrder" }, 0.5, { offsets: offsetsFor(slots, ["e", "a", "b", "c", "d"]) })(s);
    const a = s.animations![0]! as Animation;
    expect(drawOrderAt(a, slots, 0.2)).toEqual(slots);
    expect(drawOrderAt(a, slots, 0.5)).toEqual(["e", "a", "b", "c", "d"]);
    expect(drawOrderAt(a, slots, 3)).toEqual(["e", "a", "b", "c", "d"]);
  });
  it("events: defined, keyed in the order fired on one frame, renamed and deleted with their keys, written as Spine reads them", () => {
    let s = addAnimation("go")(newSkeleton("h"));
    s = defineEvent("step", { int: 1, audio: "step.wav", volume: 0.8 })(s);
    s = defineEvent("hit", {})(s);
    s = keyEvent("go", 0.5, "step", { volume: 0.5 })(s);
    s = keyEvent("go", 0.25, "hit")(s);
    s = keyEvent("go", 0.5, "hit")(s);
    expect(s.animations![0]!.events!.map((k) => [k.time ?? 0, k.name])).toEqual([[0.25, "hit"], [0.5, "step"], [0.5, "hit"]]);
    s = renameEvent("step", "footstep")(s);
    expect(s.events!.map((e) => e.name)).toEqual(["footstep", "hit"]);
    expect(s.animations![0]!.events![1]).toMatchObject({ name: "footstep", volume: 0.5 });
    const back = readSkeleton(writeSkeleton(s)).skeleton;
    expect(writeSkeleton(back)).toBe(writeSkeleton(s));
    expect(back.events![0]).toMatchObject({ name: "footstep", int: 1, audio: "step.wav", volume: 0.8 });
    s = deleteEventKeys("go", 0.5, "hit")(s);
    expect(s.animations![0]!.events!.map((k) => k.name)).toEqual(["hit", "footstep"]);
    s = deleteEvent("hit")(s);
    expect(s.events!.map((e) => e.name)).toEqual(["footstep"]);
    expect(s.animations![0]!.events!.map((k) => k.name)).toEqual(["footstep"]);
    expect(refused(() => keyEvent("go", 0, "boom")(s))).toBe('There is no event "boom": define it first.');
    expect(refused(() => defineEvent("x", { volume: 2 })(s))).toBe("Volume is from 0 to 1.");
    expect(refused(() => renameEvent("footstep", "footstep2")(defineEvent("footstep2", {})(s)))).toBe('There is already an event "footstep2".');
  });
});
