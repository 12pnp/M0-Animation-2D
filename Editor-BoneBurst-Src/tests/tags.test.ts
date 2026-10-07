import { describe, expect, it } from "vitest";
import { cleanTag, parseTags, renameTagged, tagCounts, tagKeyOf, tagMatches, tagsFor, withoutTag, withTags } from "@/edit/tags";
import { EMPTY_SIDECAR, type Sidecar } from "@/model/sidecar";

const S = (tags: Sidecar["tags"]): Sidecar => ({ ...EMPTY_SIDECAR, tags });

describe("tags", () => {
  it("name an element by what it is", () => {
    expect(tagKeyOf({ kind: "bone", name: "leg" })).toBe("bone:leg");
    expect(tagKeyOf({ kind: "attachment", skin: "default", slot: "eye", key: "open" })).toBe("attachment:default/eye/open");
    expect(tagKeyOf({ kind: "constraint", type: "ik", name: "reach" })).toBe("constraint:ik/reach");
  });
  it("clean what is typed: trimmed, commas and runs of space folded, 40 characters, one of each", () => {
    expect(cleanTag("  left   leg ")).toBe("left leg");
    expect(cleanTag("x".repeat(60))).toHaveLength(40);
    expect(parseTags("IK, left leg,, ik ,  ")).toEqual(["IK", "left leg"]);
  });
  it("add and remove, ignoring case; an element with none has no entry", () => {
    const a = withTags(EMPTY_SIDECAR, "bone:leg", ["IK"]);
    expect(tagsFor(a, "bone:leg")).toEqual(["IK"]);
    expect(withTags(a, "bone:leg", ["ik"])).toBe(a);
    const b = withTags(a, "bone:leg", ["left"]);
    expect(tagsFor(b, "bone:leg")).toEqual(["IK", "left"]);
    expect(withoutTag(withoutTag(b, "bone:leg", "IK"), "bone:leg", "LEFT").tags).toEqual([]);
    expect(withoutTag(b, "bone:leg", "nope")).toBe(b);
  });
  it("count the tags in use, most used first", () => {
    const s = S([{ key: "bone:a", tags: ["IK", "arm"] }, { key: "bone:b", tags: ["ik"] }, { key: "slot:c", tags: ["arm", "ik"] }]);
    expect(tagCounts(s)).toEqual([{ tag: "IK", count: 3 }, { tag: "arm", count: 2 }]);
  });
  it("match a search: # for exactly that tag, else a tag that holds the text", () => {
    expect(tagMatches(["IK", "left leg"], "#ik")).toBe(true);
    expect(tagMatches(["IK", "left leg"], "#i")).toBe(false);
    expect(tagMatches(["IK", "left leg"], "left")).toBe(true);
    expect(tagMatches(["IK"], "arm")).toBe(false);
    expect(tagMatches(["IK"], "#")).toBe(false);
  });
  it("move with a rename: the element's own, a slot's attachments, a skin's attachments", () => {
    const s = S([{ key: "bone:leg", tags: ["a"] }, { key: "slot:eye", tags: ["b"] }, { key: "attachment:default/eye/open", tags: ["c"] }, { key: "attachment:red/eye/open", tags: ["d"] }]);
    expect(renameTagged(s, { kind: "bone", name: "leg" }, "shin").tags.map((e) => e.key)).toContain("bone:shin");
    expect(renameTagged(s, { kind: "slot", name: "eye" }, "iris").tags.map((e) => e.key)).toEqual(["bone:leg", "slot:iris", "attachment:default/iris/open", "attachment:red/iris/open"]);
    expect(renameTagged(s, { kind: "skin", name: "red" }, "blue").tags.map((e) => e.key)).toContain("attachment:blue/eye/open");
    expect(renameTagged(s, { kind: "attachment", skin: "default", slot: "eye", key: "open" }, "shut").tags.map((e) => e.key)).toContain("attachment:default/eye/shut");
    expect(renameTagged(s, { kind: "bone", name: "nobody" }, "x")).toBe(s);
  });
});
