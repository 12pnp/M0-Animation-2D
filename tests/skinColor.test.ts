import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { withSkinColor } from "@/core/doc/skins";
import { migrate, validateProject } from "@/core/doc/schema";
import { exportSpine } from "@/core/spine/exportSpine";
import { importSpine } from "@/core/spine/importSpine";
import type { SymbolItem } from "@/core/doc/types";
import { loadStickman } from "./fixtures/stickman";

beforeEach(() => reseed());

describe("a skin's colour", () => {
  it("set, lower case, and cleared back to Spine's default; the other skins untouched", async () => {
    const { rig } = await loadStickman();
    rig.skins = [{ name: "a" }, { name: "b", color: "112233ff" }];
    const set = withSkinColor(rig, "a", "AABBCCFF");
    expect(set.skins!.map((d) => d.color)).toEqual(["aabbccff", "112233ff"]);
    expect(set.skins![1]).toBe(rig.skins[1]);
    expect(withSkinColor(rig, "b", undefined).skins![1]!.color).toBeUndefined();
  });

  it("written as the skin's colour, nonessential: left out without nonessential data; read back as the skin's own", async () => {
    const { project, rig } = await loadStickman();
    rig.skins = [{ name: "warm", color: "ff8800ff" }, { name: "plain" }];
    const out = exportSpine(project).skeleton;
    const warm = out.skins!.find((s) => s.name === "warm") as unknown as Record<string, unknown>;
    expect(warm.color).toBe("ff8800ff");
    expect((out.skins!.find((s) => s.name === "plain") as unknown as Record<string, unknown>).color).toBeUndefined();
    project.exportSettings = { ...project.exportSettings, nonessential: false } as never;
    expect((exportSpine(project).skeleton.skins!.find((s) => s.name === "warm") as unknown as Record<string, unknown>).color).toBeUndefined();
    const opened = importSpine(out as never, "stickman", new Map()).project;
    const sym = opened.items[opened.rootSymbolId] as SymbolItem;
    expect(sym.skins!.find((d) => d.name === "warm")!.color).toBe("ff8800ff");
    expect(sym.spine!.skins.some((s) => s.name === "warm")).toBe(false);
  });

  it("loading keeps a colour \"rrggbbaa\" and drops anything else", async () => {
    const { project, rig } = await loadStickman();
    rig.skins = [{ name: "a", color: "AABBCCDD" }, { name: "b", color: "orange" }];
    const out = validateProject(migrate(JSON.parse(JSON.stringify(project)))).project.items[rig.id] as SymbolItem;
    expect(out.skins!.map((d) => d.color)).toEqual(["aabbccdd", undefined]);
  });
});
