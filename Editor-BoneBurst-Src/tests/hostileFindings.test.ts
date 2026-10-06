import { describe, expect, it } from "vitest";
import { missingRegions } from "@/engine/atlasCheck";
import { atlasImages } from "@/engine/regions";
import { orderFromOffsets } from "@/engine/rigAnimation";
import { weightedLength } from "@/engine/rigAttachments";
import { readAtlas } from "@/io/atlas";
import { JsonSyntaxError, parseJson } from "@/io/json";
import { readSkeleton } from "@/io/skeletonRead";
import { profileIssues } from "@/model/profile";
import { Poser } from "@/ui/stage/posed";

/** What the hostile files found (E7-PLAN step 5), one row each; every row failed before its fix. */

const base = (extra: object) => JSON.stringify({
  skeleton: { spine: "4.3.0" },
  bones: [{ name: "root" }, { name: "a", parent: "root" }],
  slots: [{ name: "s", bone: "root" }, { name: "t", bone: "a" }, { name: "u", bone: "a" }],
  skins: [{ name: "default", attachments: { s: { r: { width: 2, height: 2 } } } }],
  ...extra,
});
const issues = (json: string) => { const r = readSkeleton(json); return [...r.issues, ...profileIssues(r.skeleton)].map((i) => `${i.where}: ${i.message}`); };
const mesh = (m: object) => ({ s: { m: { type: "mesh", uvs: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2], hull: 3, width: 2, height: 2, vertices: [0, 0, 1, 0, 1, 1], ...m } } });

describe("JSON the reader refuses with a reason (H2)", () => {
  it("nesting 100,000 deep: refused, not a stack overflow", () => {
    expect(() => parseJson(`${"[".repeat(100000)}${"]".repeat(100000)}`)).toThrow(JsonSyntaxError);
    expect(() => parseJson(`${"[".repeat(100000)}${"]".repeat(100000)}`)).toThrow(/nested deeper than 1000/);
  });
  it("a skeleton nests far less, and still reads", () => expect(parseJson(`${"[".repeat(900)}${"]".repeat(900)}`)).toBeDefined());
  it("1e400: refused, so the document cannot open and then fail to save", () => {
    expect(() => parseJson('{"a":1e400}')).toThrow(/number 1e400 out of range/);
    expect(() => parseJson('{"a":-1e400}')).toThrow(/out of range/);
    expect(parseJson('{"a":1e300}')).toBeDefined();
  });
});

describe("files BoneBurst's C# reader refuses say so when opened (H6)", () => {
  it.each([
    ["a mesh with odd uvs", { skins: [{ name: "default", attachments: mesh({ uvs: [0, 0, 1, 0, 1] }) }] }, /uvs come in pairs/],
    ["a triangle past the vertices", { skins: [{ name: "default", attachments: mesh({ triangles: [0, 1, 9] }) }] }, /triangle index 9 past the 3 vertices/],
    ["triangles not in threes", { skins: [{ name: "default", attachments: mesh({ triangles: [0, 1] }) }] }, /triangles come in threes/],
    ["a hull past the vertices", { skins: [{ name: "default", attachments: mesh({ hull: 9 }) }] }, /hull of 9 past the 3 vertices/],
    ["weights on bone 999", { skins: [{ name: "default", attachments: mesh({ vertices: [1, 999, 0, 0, 1, 1, 0, 0, 0, 1, 1, 1, 0, 0, 1] }) }] }, /bone index 999, past the 2 bones/],
    ["weights cut short", { skins: [{ name: "default", attachments: mesh({ vertices: [1, 0, 0, 0, 1, 2, 0] }) }] }, /end mid-vertex/],
    ["a curve of the wrong length", { animations: { w: { bones: { a: { rotate: [{ value: 1, curve: [0.5] }, { time: 1, value: 2 }] } } } } }, /a curve of 1 numbers; it needs 4/],
    ["a draw-order offset out of range", { animations: { w: { drawOrder: [{ offsets: [{ slot: "s", offset: 99 }] }] } } }, /moved past the 3 slots/],
    ["one slot moved twice", { animations: { w: { drawOrder: [{ offsets: [{ slot: "s", offset: 1 }, { slot: "s", offset: 2 }] }] } } }, /"s" is moved twice/],
    // As the C# reader since b71de45 (E7 step 7).
    ["offsets out of slot order", { animations: { w: { drawOrder: [{ offsets: [{ slot: "u", offset: -1 }, { slot: "s", offset: 1 }] }] } } }, /"s" is listed after a slot that follows it/],
    ["two slots moved to one place", { animations: { w: { drawOrder: [{ offsets: [{ slot: "s", offset: 2 }, { slot: "t", offset: 1 }] }] } } }, /"t" is moved to a place another slot takes/],
    ["a colour that is not one", { slots: [{ name: "s", bone: "root", color: "zzzzzzzz" }] }, /color "zzzzzzzz" is not a hex colour/],
    ["a key colour that is not one", { animations: { w: { slots: { s: { rgba: [{ color: "12" }] } } } } }, /color "12" is not a hex colour/],
  ])("%s", (_, extra, why) => {
    expect(issues(base(extra)).join("\n")).toMatch(why);
  });
  it("a file both readers take says nothing", () => expect(issues(base({}))).toEqual([]));
  it("an attachment whose region the atlas lacks; a sequence frame the atlas lacks", () => {
    const doc = readSkeleton(base({ skins: [{ name: "default", attachments: { s: { r: { width: 2, height: 2 }, q: { width: 1, height: 1, sequence: { count: 3, digits: 2 } } } } }] })).skeleton;
    const images = atlasImages(readAtlas("page.png\nsize: 8,8\nr\n  bounds: 0,0,2,2\nq01\n  bounds: 0,0,1,1\nq02\n  bounds: 0,0,1,1\n"));
    expect(missingRegions(doc, images).map((i) => `${i.where}: ${i.message}`)).toEqual([
      'skins/default/s/q: region "q03" is not in the atlas: drawn as nothing here, and Unity\'s bake refuses it',
    ]);
  });
});

describe("the engine poses what it is given, broken or not, without hanging or throwing (H1, H3–H5)", () => {
  it("a draw-order key moving one slot twice: an order of every slot once, the first move kept", () => {
    const slots = new Map([["s", 0], ["t", 1], ["u", 2]]);
    expect(orderFromOffsets([{ slot: "s", offset: 1 }, { slot: "s", offset: 2 }], slots, 3)).toEqual([1, 0, 2]);
    expect(orderFromOffsets([{ slot: "s", offset: 2 }, { slot: "t", offset: 1 }], slots, 3)).toEqual([1, 2, 0]);
  });
  it("weighted vertices with a negative or broken count: malformed, not walked forever", () => {
    expect(weightedLength([1, 0, 0, 0, 1, 2, 0, 0, 0, 0.5, 1, 0, 0, 0.5])).toBe(6);
    expect(weightedLength([-1, 0, 0, 0, 1])).toBeNull();
    expect(weightedLength([2, 0, 0, 0])).toBeNull();
  });
  it.each([
    ["null keys", { animations: { w: { bones: { a: { rotate: [null, { time: 1, value: 2 }] } } }, attachments: {} } }],
    ["path lengths that are not a list", { skins: [{ name: "default", attachments: { s: { p: { type: "path", vertexCount: 3, vertices: [0, 0, 1, 1, 2, 2], lengths: {} } } } }] }],
    ["a mesh with triangles out of range", { skins: [{ name: "default", attachments: mesh({ triangles: [0, 1, 1000000000] }) }], slots: [{ name: "s", bone: "root", attachment: "m" }] }],
    ["a mesh with odd uvs", { skins: [{ name: "default", attachments: mesh({ uvs: [0, 0, 1, 0, 1] }) }], slots: [{ name: "s", bone: "root", attachment: "m" }] }],
    ["a deform key of nulls", { animations: { w: { attachments: { default: { s: { m: { deform: [null, { vertices: "x" }] } } } } } }, skins: [{ name: "default", attachments: mesh({}) }] }],
  ])("%s", (_, extra) => {
    const doc = readSkeleton(base(extra)).skeleton;
    const p = new Poser(doc, atlasImages(readAtlas("page.png\nsize: 8,8\nm\n  bounds: 0,0,2,2\nr\n  bounds: 0,0,2,2\n")));
    for (const a of [null, ...(doc.animations ?? []).map((x) => x.name)]) {
      const posed = p.pose(null, a, 0.5);
      for (const d of posed.draw.slots) expect(d.triangles.every((i) => i < d.vertexCount)).toBe(true);
    }
  });
});
