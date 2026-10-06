import { describe, expect, it } from "vitest";
import { findAttachment, updateAttachment } from "@/edit/attachments";
import { addBone, deleteBone, reparentBone, updateBone } from "@/edit/bones";
import { updateConstraint } from "@/edit/constraints";
import { defineEvent, keyEvent } from "@/edit/events";
import { EditRefused } from "@/edit/history";
import { setChannelCurve, setKey } from "@/edit/keys";
import { moveVertex } from "@/edit/mesh";
import { decodeBinds } from "@/edit/meshLayout";
import { autoWeights, bindMesh, setWeight, setWeights, unbindMesh } from "@/edit/weights";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import type { Skeleton } from "@/model/skeleton";

/**
 * What the edit fuzzer found (E7-PLAN step 4), one table each; every row failed before its fix.
 */

/** root ─ a ─ a1, b; a mesh on root bound to b and a, a path bound to b; an IK on a. */
const rig = () => readSkeleton(JSON.stringify({
  skeleton: { spine: "4.3.0" },
  bones: [{ name: "root" }, { name: "a", parent: "root", length: 10 }, { name: "a1", parent: "a", x: 10 }, { name: "b", parent: "root", x: 20, length: 10 }],
  slots: [{ name: "s", bone: "root", attachment: "m" }, { name: "p", bone: "root" }, { name: "u", bone: "a" }],
  constraints: [{ type: "ik", name: "reach", bones: ["a"], target: "root" }],
  skins: [{
    name: "default",
    attachments: {
      s: { m: { type: "mesh", uvs: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2], hull: 3, width: 10, height: 10,
        vertices: [1, 3, 0, 0, 1, 2, 3, 1, 0, 0.5, 1, 0, 0, 0.5, 1, 3, 2, 2, 1] } },
      p: { pa: { type: "path", vertexCount: 3, vertices: [1, 3, 0, 0, 1, 1, 3, 1, 1, 1, 1, 3, 2, 2, 1], lengths: [1] } },
      u: { um: { type: "mesh", uvs: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2], hull: 3, width: 10, height: 10, vertices: [0, 0, 5, 0, 5, 5] } },
    },
  }],
})).skeleton;
const boundNames = (s: Skeleton, slot: string, key: string) =>
  decodeBinds(findAttachment(s, { skin: "default", slot, key })!.vertices!).flatMap((b) => b.map((x) => s.bones![x.bone]!.name));

describe("bones by index in weighted vertices follow their bones (fuzz finding F3)", () => {
  const before = rig();
  const mesh = boundNames(before, "s", "m"), path = boundNames(before, "p", "pa");
  it("starts bound to b, a, b (mesh) and b, b, b (path)", () => {
    expect(mesh).toEqual(["b", "b", "a", "b"]);
    expect(path).toEqual(["b", "b", "b"]);
  });
  it.each([
    ["a bone added before b", (s: Skeleton) => addBone("new", "a")(s)],
    ["a bone moved to after b", (s: Skeleton) => reparentBone("a", "b")(s)],
    ["a bone before b deleted", (s: Skeleton) => deleteBone("a1")(s)],
  ])("%s: each vertex still bound to the same bones, by name", (_, edit) => {
    const after = edit(before);
    expect(boundNames(after, "s", "m")).toEqual(mesh);
    expect(boundNames(after, "p", "pa")).toEqual(path);
    // And the file stays one the reader takes back as it was written.
    expect(writeSkeleton(readSkeleton(writeSkeleton(after)).skeleton)).toBe(writeSkeleton(after));
  });
  it("deleting a bone a mesh is bound to (outside the deleted slots) is refused, naming the mesh", () => {
    expect(() => deleteBone("b")(before)).toThrow(EditRefused);
    expect(() => deleteBone("b")(before)).toThrow(/"m" in the slot "s".*bound to "b"/);
  });
});

describe("numbers a file cannot hold are refused (fuzz finding F1)", () => {
  const s = rig();
  it.each([
    ["updateBone", () => updateBone("a", { rotation: NaN })(s)],
    ["addBone", () => addBone("n", "a", { x: Infinity })(s)],
    ["reparentBone", () => reparentBone("a1", "b", { y: -Infinity })(s)],
    ["updateAttachment", () => updateAttachment({ skin: "default", slot: "s", key: "m" }, { width: NaN })(s)],
    ["updateConstraint", () => updateConstraint({ type: "ik", name: "reach" }, { mix: NaN })(s)],
    ["setKey (value)", () => setKey("walk", { section: "bones", owner: "a", timeline: "rotate" }, 0, { value: NaN })({ ...s, animations: [{ name: "walk", extra: new Map() }] })],
    ["setKey (time)", () => setKey("walk", { section: "bones", owner: "a", timeline: "rotate" }, NaN, { value: 1 })({ ...s, animations: [{ name: "walk", extra: new Map() }] })],
    ["defineEvent", () => defineEvent("e", { float: Infinity })(s)],
    ["keyEvent", () => keyEvent("walk", 0, "e", { float: NaN })(defineEvent("e", {})({ ...s, animations: [{ name: "walk", extra: new Map() }] }))],
    ["setChannelCurve (F8)", () => setChannelCurve("walk", { path: { section: "bones", owner: "a", timeline: "rotate" }, time: 0 }, 0, [0.1, NaN, 0.2, 1])(setKey("walk", { section: "bones", owner: "a", timeline: "rotate" }, 1, { value: 2 })(setKey("walk", { section: "bones", owner: "a", timeline: "rotate" }, 0, { value: 1 })({ ...s, animations: [{ name: "walk", extra: new Map() }] })))],
    ["moveVertex", () => moveVertex({ skin: "default", slot: "s", key: "m" }, 0, NaN, 0, true, [[1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 0, 0], [1, 0, 0, 1, 10, 0], [1, 0, 0, 1, 20, 0]])(s)],
  ])("%s", (_, run) => {
    expect(run).toThrow(EditRefused);
    expect(run).toThrow(/must be a number/);
  });
});

describe("binding to a bone that cannot hold vertices is refused (fuzz finding F2)", () => {
  const s = rig(), u = { skin: "default", slot: "u", key: "um" };
  const id = [1, 0, 0, 1, 0, 0];
  // b inactive in the skin shown: posed as all zeros.
  const worlds = [id, id, [1, 0, 0, 1, 10, 0], [0, 0, 0, 0, 0, 0]];
  it("bindMesh to it", () => expect(() => bindMesh(u, ["a", "b"], worlds)(s)).toThrow(/"b" cannot hold vertices here/));
  it("a bone scaled to zero", () => expect(() => bindMesh(u, ["a1"], [id, id, [0, 0, 0, 1, 0, 0], id])(s)).toThrow(/"a1" cannot hold vertices here/));
  // F7: the weight fields and the weight brush add a bone to a vertex the same way.
  const m = { skin: "default", slot: "s", key: "m" }, a1Inactive = [id, id, [0, 0, 0, 0, 0, 0], [1, 0, 0, 1, 20, 0]];
  it("setWeight giving it weight (F7)", () => expect(() => setWeight(m, 0, "a1", 0.5, a1Inactive)(s)).toThrow(/"a1" cannot hold vertices here/));
  it("setWeights giving it weight (F7)", () => expect(() => setWeights(m, "a1", new Map([[0, 0.5]]), a1Inactive)(s)).toThrow(/"a1" cannot hold vertices here/));
});

describe("a mesh whose bones are inactive in the skin shown is not edited there (fuzz finding F4)", () => {
  const s = rig(), m = { skin: "default", slot: "s", key: "m" }, u = { skin: "default", slot: "u", key: "um" };
  const id = [1, 0, 0, 1, 0, 0], zero = [0, 0, 0, 0, 0, 0];
  it.each([
    ["moveVertex, a bound bone inactive", () => moveVertex(m, 0, 1, 1, true, [id, id, id, zero])(s), /"m" cannot be edited here: its bone "b" is not active/],
    ["autoWeights, a bound bone inactive", () => autoWeights(m, [id, id, id, zero])(s), /"m" cannot be edited here: its bone "b" is not active/],
    ["unbindMesh, a bound bone inactive", () => unbindMesh(m, [id, id, id, zero])(s), /"m" cannot be edited here: its bone "b" is not active/],
    ["moveVertex, the slot's bone inactive", () => moveVertex(u, 0, 1, 1, true, [id, zero, id, id])(s), /"um" cannot be edited here: its bone "a" is not active/],
  ])("%s", (_, run, why) => {
    expect(run).toThrow(EditRefused);
    expect(run).toThrow(why);
  });
});
