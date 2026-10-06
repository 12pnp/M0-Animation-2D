import { describe, expect, it } from "vitest";
import { addAnimation } from "@/edit/animations";
import { keyBone, type LocalPose } from "@/edit/boneKeys";
import { PRESETS } from "@/edit/curves";
import { setChannelCurve, setCurve, setKey } from "@/edit/keys";
import { newSkeleton } from "@/edit/newSkeleton";
import type { Skeleton } from "@/model/skeleton";
import { frameTime, keyLists } from "@/model/timelines";
import { channelField, channelsOf, fitValues, intervals, valueY, yValue } from "@/ui/timeline/graph";

/** The curve graph (E6 step 4g): channels, intervals and handles, the fit, and the curve edit. */

const fps = 30, t = (f: number) => frameTime(f, fps);
const pose = (o: Partial<LocalPose>): LocalPose => ({ x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, shearX: 0, shearY: 0, ...o });
function rig(): Skeleton {
  let s = addAnimation("a")(newSkeleton("h"));
  s = keyBone("a", "root", ["rotate", "translate"], pose({ rotation: 0, x: 0, y: 0 }), t(0))(s);
  s = keyBone("a", "root", ["rotate", "translate"], pose({ rotation: 90, x: 30, y: -12 }), t(10))(s);
  s = keyBone("a", "root", ["rotate", "translate"], pose({ rotation: 45, x: 30, y: 0 }), t(20))(s);
  return s;
}
const lists = (s: Skeleton) => keyLists(s.animations![0]!);

describe("the curve graph (E6 step 4g)", () => {
  it("a channel per timeline axis, labelled; intervals straight, stepped or bezier, with handles (a straight one's at its thirds)", () => {
    let s = rig();
    s = setCurve("a", [{ path: { section: "bones", owner: "root", timeline: "rotate" }, time: t(10) }], "stepped")(s);
    s = setCurve("a", [{ path: { section: "bones", owner: "root", timeline: "translate" }, time: 0 }], PRESETS.easeInOut)(s);
    const chs = channelsOf(lists(s));
    expect(chs.map((c) => c.label)).toEqual(["root · rotate", "root · translate x", "root · translate y"]);
    const rot = intervals(chs[0]!);
    expect(rot.map((i) => i.kind)).toEqual(["linear", "stepped"]);
    expect(rot[0]!.h).toEqual([t(10) / 3, 30, (2 * t(10)) / 3, 60]);
    const x = intervals(chs[1]!);
    expect(x[0]!.kind).toBe("bezier");
    expect(x[0]!.h[0]).toBeCloseTo(0.42 * t(10), 5);
    expect(x[0]!.h[3]).toBeCloseTo(30, 5);
    expect(channelField(chs[0]!.path, 0)).toBe("value");
    expect(channelField(chs[2]!.path, 1)).toBe("y");
    expect(channelField({ section: "slots", owner: "s", timeline: "rgba" }, 0)).toBeNull();
  });

  it("the fit holds every key and handle with a margin; a flat channel is opened up; y and value invert", () => {
    const chs = channelsOf(lists(rig()));
    const fit = fitValues(chs);
    expect(fit.min).toBeLessThan(-12);
    expect(fit.max).toBeGreaterThan(90);
    expect(fitValues([]).min).toBeLessThan(fitValues([]).max);
    expect(yValue(fit, 10, 110, valueY(fit, 10, 110, 37))).toBeCloseTo(37, 9);
  });

  it("setChannelCurve: a straight interval becomes a curve on that channel, the others straight; handle times kept in the interval", () => {
    const s = rig(), path = { section: "bones" as const, owner: "root", timeline: "translate" };
    const out = setChannelCurve("a", { path, time: 0 }, 1, [-1, -20, t(5), -2])(s);
    const k = out.animations![0]!.bones![0]!.timelines.find((x) => x.name === "translate")!.keys[0]!;
    const c = k.curve as number[];
    // Channel 0 (x) straight: its thirds; channel 1 (y): the handles, the first's time clamped to 0.
    expect(c.slice(0, 4).map((v) => Math.round(v * 1000) / 1000)).toEqual([Math.round((t(10) / 3) * 1000) / 1000, 10, Math.round(((2 * t(10)) / 3) * 1000) / 1000, 20]);
    expect(c.slice(4)).toEqual([0, -20, t(5), -2]);
    expect(() => setChannelCurve("a", { path, time: t(20) }, 0, [0, 0, 0, 0])(s)).toThrow(/last key/);
    // A value set on one channel leaves the other.
    const moved = setKey("a", path, t(10), { y: 5 })(s);
    expect(moved.animations![0]!.bones![0]!.timelines.find((x) => x.name === "translate")!.keys[1]).toMatchObject({ x: 30, y: 5 });
  });
});
