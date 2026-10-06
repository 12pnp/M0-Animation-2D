import { describe, expect, it } from "vitest";
import { boneColourOf, boneColourToFile, boneIconOf } from "@/ui/boneLook";

describe("a bone's colour and icon", () => {
  it("reads rrggbb and rrggbbaa, and nothing else, as a colour", () => {
    expect(boneColourOf({ color: "ff8800ff" })).toBe("#ff8800");
    expect(boneColourOf({ color: "FF8800" })).toBe("#ff8800");
    expect(boneColourOf({ color: "ff88" })).toBeNull();
    expect(boneColourOf({})).toBeNull();
  });
  it("writes a colour as rrggbbff", () => {
    expect(boneColourToFile("#FF8800")).toBe("ff8800ff");
    expect(boneColourOf({ color: boneColourToFile("#12ab34") })).toBe("#12ab34");
  });
  it("uses the named icon when it is one of ours, else the bone's own", () => {
    expect(boneIconOf({ icon: "point" })).toBe("point");
    expect(boneIconOf({ icon: "star" })).toBe("bone");
    expect(boneIconOf({})).toBe("bone");
  });
});
