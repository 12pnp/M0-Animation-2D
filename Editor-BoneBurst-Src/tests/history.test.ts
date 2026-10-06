import { describe, expect, it } from "vitest";
import { EditRefused, History } from "@/edit/history";
import { renameBone, updateBone } from "@/edit/bones";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import { profileIssues } from "@/model/profile";
import type { Skeleton } from "@/model/skeleton";
import { sampleFiles } from "./fixtures/samples";

const doc = () => readSkeleton(JSON.stringify({
  skeleton: { spine: "4.3.0" },
  bones: [{ name: "root" }, { name: "hip", parent: "root", x: 1 }, { name: "leg", parent: "hip" }],
  slots: [{ name: "body", bone: "hip" }],
  constraints: [{ name: "reach", type: "ik", bones: ["leg"], target: "hip" }, { name: "wobble", type: "physics", bone: "hip" }],
  skins: [{ name: "extra", bones: ["hip"] }],
  animations: { walk: { bones: { hip: { rotate: [{ value: 5 }] } } } },
})).skeleton;
const bone = (s: Skeleton, n: string) => s.bones!.find((b) => b.name === n);

describe("History", () => {
  it("undoes to the very document it had, and redoes", () => {
    const h = new History(doc());
    const before = h.doc;
    expect(h.apply("Move hip", updateBone("hip", { x: 9 }))).toBe(true);
    expect(bone(h.doc, "hip")!.x).toBe(9);
    expect(h.undoLabel).toBe("Move hip");
    h.undo();
    expect(h.doc).toBe(before);
    h.redo();
    expect(bone(h.doc, "hip")!.x).toBe(9);
  });
  it("records nothing for an edit that changes nothing", () => {
    const h = new History(doc());
    expect(h.apply("Same", updateBone("hip", { x: 1 }))).toBe(false);
    expect(h.canUndo).toBe(false);
  });
  it("makes a gesture one step, and none when no step changed anything", () => {
    const h = new History(doc());
    h.begin("Drag hip");
    for (const x of [2, 3, 4]) h.apply("step", updateBone("hip", { x }));
    h.end();
    h.undo();
    expect(bone(h.doc, "hip")!.x).toBe(1);
    expect(h.canUndo).toBe(false);
    h.begin("Touch");
    h.apply("step", updateBone("hip", { x: 1 }));
    h.end();
    expect(h.canRedo).toBe(true); // nothing recorded, so the old redo stays
  });
  it("cancels a gesture back to where it started", () => {
    const h = new History(doc());
    const start = h.doc;
    h.begin("Drag");
    h.apply("step", updateBone("hip", { x: 5 }));
    h.cancel();
    expect(h.doc).toBe(start);
    expect(h.canUndo).toBe(false);
  });
  it("passes a refusal through, untouched", () => {
    const h = new History(doc());
    const start = h.doc;
    expect(() => h.apply("Parent", updateBone("root", { parent: "leg" }))).toThrow(EditRefused);
    expect(h.doc).toBe(start);
  });
  it("freezes documents under test, so a mutating edit fails", () => {
    const h = new History(doc());
    expect(() => h.apply("Bad", (s) => { (s.bones![0] as { x?: number }).x = 3; return s; })).toThrow(TypeError);
  });
});

describe("updateBone", () => {
  it("removes a field set to undefined, leaving the default", () => {
    const s = updateBone("hip", { x: undefined })(doc());
    expect("x" in bone(s, "hip")!).toBe(false);
  });
});

describe("renameBone", () => {
  it("renames the bone and every reference", () => {
    const s = renameBone("hip", "pelvis")(doc());
    expect(s.bones!.map((b) => [b.name, b.parent])).toEqual([["root", undefined], ["pelvis", "root"], ["leg", "pelvis"]]);
    expect(s.slots![0]!.bone).toBe("pelvis");
    expect(s.constraints!.map((c) => ("target" in c ? c.target : "bone" in c ? c.bone : null))).toEqual(["pelvis", "pelvis"]);
    expect(s.skins![0]!.bones).toEqual(["pelvis"]);
    expect(s.animations![0]!.bones!.map((g) => g.name)).toEqual(["pelvis"]);
    expect(profileIssues(s)).toEqual([]);
  });
  it.each([["", /needs a name/], ["leg", /already a bone "leg"/]])("refuses %j", (to, want) => {
    expect(() => renameBone("hip", to)(doc())).toThrow(want);
  });
  it("keeps every sample whole: renamed and back is the file it was", () => {
    for (const f of sampleFiles(".json")) {
      const s = readSkeleton(f.text).skeleton;
      const b = s.bones?.at(-1)?.name;
      if (!b) continue;
      const there = renameBone(b, `${b}__renamed`)(s);
      expect(profileIssues(there), f.name).toEqual([]);
      expect(writeSkeleton(renameBone(`${b}__renamed`, b)(there)), f.name).toBe(writeSkeleton(s));
    }
  });
});

describe("History entries and goTo (E7 step 1)", () => {
  const three = () => {
    const h = new History(doc());
    const docs = [h.doc];
    for (const x of [11, 12, 13]) { h.apply(`Move hip to ${x}`, updateBone("hip", { x })); docs.push(h.doc); }
    return { h, docs };
  };
  it("lists the done steps then the undone ones, oldest first", () => {
    const { h } = three();
    h.undo();
    expect(h.entries).toEqual({ labels: ["Move hip to 11", "Move hip to 12", "Move hip to 13"], done: 2, dropped: 0 });
  });
  it("goes to any step through every step between, to the very documents, and back", () => {
    const { h, docs } = three();
    let steps = 0;
    expect(h.goTo(0, () => steps++)).toBe(true);
    expect(h.doc).toBe(docs[0]);
    expect(steps).toBe(3);
    expect(h.entries).toEqual({ labels: ["Move hip to 11", "Move hip to 12", "Move hip to 13"], done: 0, dropped: 0 });
    expect(h.goTo(2, () => steps++)).toBe(true);
    expect(h.doc).toBe(docs[2]);
    expect(steps).toBe(5);
    // The redo step after it is still there: nothing is lost until a new edit.
    expect(h.entries.labels).toHaveLength(3);
    expect(h.goTo(3)).toBe(true);
    expect(h.doc).toBe(docs[3]);
  });
  it("refuses out of range, the current step, and inside a gesture", () => {
    const { h, docs } = three();
    expect(h.goTo(-1)).toBe(false);
    expect(h.goTo(4)).toBe(false);
    expect(h.goTo(3)).toBe(false);
    h.begin("Drag");
    expect(h.goTo(0)).toBe(false);
    h.cancel();
    expect(h.doc).toBe(docs[3]);
  });
  it("a new edit after going back drops the steps after it", () => {
    const { h } = three();
    h.goTo(1);
    h.apply("Rename", renameBone("leg", "shin"));
    expect(h.entries).toEqual({ labels: ["Move hip to 11", "Rename"], done: 2, dropped: 0 });
  });
  it("counts the steps the limit let go of", () => {
    const h = new History(doc(), 2);
    for (const x of [11, 12, 13, 14]) h.apply(`x ${x}`, updateBone("hip", { x }));
    expect(h.entries).toEqual({ labels: ["x 13", "x 14"], done: 2, dropped: 2 });
  });
});
