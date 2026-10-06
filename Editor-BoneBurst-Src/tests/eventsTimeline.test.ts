import { describe, expect, it } from "vitest";
import { addAnimation } from "@/edit/animations";
import { defineEvent, keyEvent } from "@/edit/events";
import { deleteKeys, moveKeys } from "@/edit/keys";
import { newSkeleton } from "@/edit/newSkeleton";
import type { Skeleton } from "@/model/skeleton";
import { frameTime } from "@/model/timelines";
import { buildRows, marks, refId } from "@/ui/timeline/layout";

/** Events on the timeline (E6 step 4b): a row per event, and keys that are one event's, even on a shared frame. */

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

describe("events on the timeline (E6 step 4b)", () => {
  it("a row per event the animation fires, in the skeleton's order, and the selected event's even unkeyed; each mark names its event", () => {
    const s = rig();
    const rows = buildRows(s, anim(s), null, new Set()).filter((r) => r.event !== undefined);
    expect(rows.map((r) => r.label)).toEqual(["step", "dust"]);
    expect(buildRows(s, anim(s), null, new Set(), "sound").filter((r) => r.event).map((r) => r.label)).toEqual(["step", "dust", "sound"]);
    const step = marks(rows[0]!, fps);
    expect(step.map((m) => m.frame)).toEqual([4, 10]);
    expect(step[0]!.refs).toEqual([{ path: { section: "events" }, time: frameTime(4, fps), name: "step" }]);
    // Two events on frame 4 are two keys in the selection.
    expect(refId(step[0]!.refs[0]!, fps)).not.toBe(refId(marks(rows[1]!, fps)[0]!.refs[0]!, fps));
  });

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
