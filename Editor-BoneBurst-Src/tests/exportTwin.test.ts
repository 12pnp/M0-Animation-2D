import { describe, expect, it } from "vitest";
import { exportTwin, parseTwinSpline, twinSummary, writeTwinSpline, type ConvertKeys } from "@/edit/exportTwin";
import { EditRefused } from "@/edit/history";
import { writeSkeleton } from "@/io/skeletonWrite";
import { readSkeleton } from "@/io/skeletonRead";
import type { MotionPath } from "@/model/sidecar";
import { keyLists } from "@/model/timelines";

const text = JSON.stringify({
  skeleton: { spine: "4.3.0" },
  bones: [{ name: "root" }, { name: "hips", parent: "root", x: 10 }, { name: "arm", parent: "hips" }, { name: "still", parent: "root" }],
  animations: {
    run: { bones: {
      hips: { translate: [{ x: 0, y: 0 }, { time: 0.5, x: 20, y: 5 }], rotate: [{ value: 0 }, { time: 0.5, value: 10 }] },
      arm: { translate: [{ x: 0 }, { time: 0.5, x: 5 }] },
      still: { rotate: [{ value: 0 }, { time: 0.5, value: 3 }] },
    } },
    idle: { bones: { arm: { translate: [{ x: 1 }, { time: 1, x: 1 }] } } },
  },
});
const doc = readSkeleton(text).skeleton;
const path = (bone: string, extra: Partial<MotionPath> = {}): MotionPath => ({ animation: "run", bone, nodes: [{ x: 0, y: 0, id: 7 }, { x: 30, y: 4, tx: 5, ty: 0, speed: 1.5 }], closed: false, duration: 0.5, loop: true, ...extra });
const translates = (d: typeof doc, an: string): string[] => keyLists(d.animations!.find((a) => a.name === an)!).flatMap((l) => (l.path.section === "bones" && /translate/.test(l.path.timeline) ? [l.path.owner] : []));
const never: ConvertKeys = () => { throw new Error("not called"); };

describe("the TwinSpline export (docs/UNITY-EXPORT-PLAN.md)", () => {
  it("writes a bone's own path as it is, without the editor's number, and takes its translate keys out of the skeleton copy only", () => {
    const out = exportTwin(doc, [path("hips")], (an, bone) => bone === "arm" && an === "run" ? { path: path("arm"), stray: 0.1 } : null);
    expect(out.file.animations["run"]!["hips"]).toEqual({ parent: "root", duration: 0.5, loop: true, closed: false, nodes: [{ x: 0, y: 0 }, { x: 30, y: 4, tx: 5, ty: 0, speed: 1.5 }] });
    expect(translates(out.skeleton, "run")).toEqual([]);
    // Everything else stays: hips' rotation, still's rotation, and the document itself is untouched.
    expect(keyLists(out.skeleton.animations![0]!).filter((l) => l.path.section === "bones" && /rotate/.test(l.path.timeline))).toHaveLength(2);
    expect(translates(doc, "run")).toEqual(["hips", "arm"]);
    expect(out.report.lines.map((l) => `${l.animation}/${l.bone}:${l.source}`)).toEqual(["run/hips:path", "run/arm:keys"]);
  });
  it("converts a bone that has keys only, and keeps as keys one it cannot convert, one that strays too far, and one with no pose", () => {
    const convert: ConvertKeys = (an, bone) => {
      if (an === "idle") throw new EditRefused("the keys do not move it");
      return bone === "hips" ? { path: path("hips", { parent: "root" }), stray: 0.2 } : { path: path("arm"), stray: 2 };
    };
    const out = exportTwin(doc, [], convert);
    expect(Object.keys(out.file.animations["run"]!)).toEqual(["hips"]);
    expect(out.report.kept.map((k) => `${k.animation}/${k.bone}`)).toEqual(["run/arm", "idle/arm"]);
    expect(out.report.kept[0]!.why).toMatch(/stray 2\.00/);
    expect(out.report.kept[1]!.why).toBe("the keys do not move it");
    expect(translates(out.skeleton, "run")).toEqual(["arm"]);
    expect(translates(out.skeleton, "idle")).toEqual(["arm"]);
    expect(twinSummary(out.report)).toMatch(/1 bone as TwinSpline \(0 from their paths, 1 converted from keys, at worst 0\.20.*2 left as keys/);
    expect(exportTwin(doc, [], () => null).report.kept[0]!.why).toMatch(/no pose/);
  });
  it("follows the bone's choice: a path set aside is converted from the keys, and a path with no keys still exports", () => {
    let asked = "";
    const out = exportTwin(doc, [path("hips", { active: false }), path("still")], (an, bone) => { asked += `${an}/${bone} `; return { path: path(bone, { parent: "root" }), stray: 0 }; });
    expect(asked).toBe("run/hips run/arm idle/arm ");
    expect(out.report.lines.find((l) => l.bone === "still")!.source).toBe("path");
    expect(out.file.animations["run"]!["still"]!.parent).toBe("root");
  });
  it("a bone with no translate motion adds nothing, and a document without any gives an empty file and the same skeleton", () => {
    const quiet = readSkeleton(JSON.stringify({ skeleton: { spine: "4.3.0" }, bones: [{ name: "root" }], animations: { a: { bones: { root: { rotate: [{ value: 0 }, { time: 1, value: 5 }] } } } } })).skeleton;
    const out = exportTwin(quiet, [], never);
    expect(out.file.animations).toEqual({});
    expect(writeSkeleton(out.skeleton)).toBe(writeSkeleton(quiet));
  });
  it("the file reads back to what was written, byte for byte, and a bad file says what is wrong", () => {
    const out = exportTwin(doc, [path("hips"), path("arm", { parent: "hips", closed: true, nodes: [{ x: 1, y: 2, bx: 3, by: 4, ss: 0.5, sb: 0.25 }, { x: 5, y: 6 }, { x: 7, y: 8 }] })], () => null);
    const written = writeTwinSpline(out.file);
    expect(writeTwinSpline(parseTwinSpline(written))).toBe(written);
    expect(JSON.parse(written).twinspline).toBe(1);
    expect(() => parseTwinSpline('{"twinspline":2,"animations":{}}')).toThrow(/version 1/);
    expect(() => parseTwinSpline('{"twinspline":1,"animations":{"a":{"b":{"nodes":[{"x":0,"y":0}],"duration":1,"loop":true,"closed":false}}}}')).toThrow(/at least two nodes/);
    expect(() => parseTwinSpline('{"twinspline":1,"animations":{"a":{"b":{"nodes":[{"x":0,"y":0},{"x":1,"y":1}],"duration":0,"loop":true,"closed":false}}}}')).toThrow(/duration/);
  });
});
