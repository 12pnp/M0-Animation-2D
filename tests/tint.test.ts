import { beforeEach, describe, expect, it } from "vitest";
import { reseed, type ItemId } from "@/core/doc/ids";
import { createNode } from "@/core/doc/defaults";
import { displaysOf, withDisplayTint } from "@/core/doc/displays";
import { runtimePosed } from "@/core/doc/inherit";
import { migrate, validateProject } from "@/core/doc/schema";
import { exportSpine } from "@/core/spine/exportSpine";
import { importSpine } from "@/core/spine/importSpine";
import { posedSymbol } from "@/core/spine/spinePose";
import type { SymbolItem } from "@/core/doc/types";
import { loadStickman } from "./fixtures/stickman";

beforeEach(() => reseed());

const node = () => ({ ...createNode("image", "face", { itemId: "a" as ItemId }), extraDisplays: [{ itemId: "b" as ItemId, pivot: { x: 1, y: 1 } }] });

describe("a display's tint", () => {
  it.each([
    { name: "display 0", index: 0, tint: "FF000080", want: [undefined, "ff000080", undefined] },
    { name: "another display", index: 1, tint: "00ff00ff", want: [undefined, undefined, "00ff00ff"] },
    { name: "white is none", index: 0, tint: "ffffffff", want: [undefined, undefined, undefined] },
  ])("$name", ({ index, tint, want }) => {
    const n = withDisplayTint(node(), index, tint);
    expect([undefined, n.tint, n.extraDisplays![0]!.tint]).toEqual(want);
  });

  it("cleared by undefined; a display it does not have leaves the node as it is", () => {
    const n = withDisplayTint(node(), 1, "123456ff");
    expect(displaysOf(withDisplayTint(n, 1, undefined))[1]!.tint).toBeUndefined();
    expect(withDisplayTint(n, 5, "000000ff")).toBe(n);
  });
});

describe("in the file and on the stage", () => {
  it("written as the attachment's colour; the stage, posed by spine-core, multiplies it in; read back as the tint", async () => {
    const { project, rig } = await loadStickman();
    const torso = Object.values(rig.nodes).find((n) => n.itemId && n.name.includes("torso"))!;
    rig.nodes[torso.id] = withDisplayTint(torso, 0, "8040ffcc");
    expect(runtimePosed(rig)).toBe(true);
    const out = exportSpine(project);
    const slot = out.skeleton.slots!.find((s) => s.name === torso.name)!;
    const att = out.skeleton.skins![0]!.attachments![slot.name]!;
    expect(Object.values(att)[0]).toMatchObject({ color: "8040ffcc" });
    const e = posedSymbol(project, rig, null, 0, "setup").byNode.get(torso.id)!;
    expect(e.color.rM).toBeCloseTo((0x80 / 255) * 100, 3);
    expect(e.color.gM).toBeCloseTo((0x40 / 255) * 100, 3);
    expect(e.color.aM).toBeCloseTo((0xcc / 255) * 100, 3);
    const images = new Map(Object.values(project.items).filter((i) => i.kind === "image").map((i) => [i.name, { name: i.name, width: (i as { width: number }).width, height: (i as { height: number }).height, assetId: (i as unknown as { assetId: never }).assetId }]));
    const opened = importSpine(out.skeleton as never, "stickman", images).project;
    const back = Object.values((opened.items[opened.rootSymbolId] as SymbolItem).nodes).find((n) => n.name === torso.name && n.kind === "image");
    expect(back && displaysOf(back)[0]!.tint).toBe("8040ffcc");
  });

  it("loading keeps a tint and drops one that is not \"rrggbbaa\"", async () => {
    const { project, rig } = await loadStickman();
    const [a, b] = Object.values(rig.nodes).filter((n) => n.itemId);
    rig.nodes[a!.id] = { ...a!, tint: "AABBCCDD" };
    rig.nodes[b!.id] = { ...b!, tint: "red" };
    const nodes = (validateProject(migrate(JSON.parse(JSON.stringify(project)))).project.items[rig.id] as SymbolItem).nodes;
    expect(nodes[a!.id]!.tint).toBe("aabbccdd");
    expect(nodes[b!.id]!.tint).toBeUndefined();
  });
});
