import { describe, expect, it } from "vitest";
import { addAnimation } from "@/edit/animations";
import { defineEvent, keyEvent } from "@/edit/events";
import { deleteKeys, moveKeys } from "@/edit/keys";
import { newSkeleton } from "@/edit/newSkeleton";
import type { Skeleton } from "@/model/skeleton";
import { frameTime } from "@/model/timelines";

/** Event keys (E6 step 4b): keys that are one event's, even on a shared frame. */

const fps = 30;
function rig(): Skeleton {
  let s = addAnimation("walk")(newSkeleton("h"));
  for (const e of ["step", "dust", "sound"]) s = defineEvent(e, {})(s);
  s = keyEvent("walk", frameTime(4, fps), "step")(s);
  s = keyEvent("walk", frameTime(4, fps), "dust")(s);
  s = keyEvent("walk", frameTime(10, fps), "step")(s);
  return s;
}
const anim = (s: Skeleton) => s.animations!.find((a) => a.name === "walk")!;
const fired = (s: Skeleton) => (anim(s).events ?? []).map((k) => `${k.name}@${Math.round((k.time ?? 0) * fps)}`);

describe("event keys", () => {
  it("deleting or moving one event's key leaves the other event on that frame", () => {
    const s = rig();
    const dust = { path: { section: "events" as const }, time: frameTime(4, fps), name: "dust" };
    expect(fired(deleteKeys("walk", [dust])(s))).toEqual(["step@4", "step@10"]);
    // Onto another event's frame: allowed (events may share a frame).
    expect(fired(moveKeys("walk", [dust], 6, fps)(s))).toEqual(["step@4", "dust@10", "step@10"]);
    // A ref without a name still takes every key at its time (other timelines' keys are as before).
    expect(fired(deleteKeys("walk", [{ path: { section: "events" }, time: frameTime(4, fps) }])(s))).toEqual(["step@10"]);
  });
});
