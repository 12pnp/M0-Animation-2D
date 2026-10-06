import { describe, expect, it } from "vitest";
import { AgentRefused, callTool } from "@/agent/host";
import { numberedRun } from "@/agent/sequences";
import { findAttachment } from "@/edit/attachments";
import { History } from "@/edit/history";
import { type AtlasImages, atlasImages } from "@/engine/regions";
import type { Skeleton } from "@/model/skeleton";
import { poserCache } from "@/ui/agent/context";
import { importPsd } from "@/ui/psdImport";
import { testContext } from "./fixtures/agentContext";
import { figureLayers, part, writeFigure } from "./fixtures/psd";

/** Skins, tints and sequences (E5 step 8): each tool's edit, and what the runtime then draws. */

type Ctx = ReturnType<typeof testContext>;
const call = (c: Ctx, name: string, args: unknown) => callTool(name, args, c) as Promise<Record<string, any>>;
const refused = async (p: Promise<unknown>) => { try { await p; return ""; } catch (e) { expect(e).toBeInstanceOf(AgentRefused); return (e as Error).message; } };

function open(layers = figureLayers()): { c: Ctx; images: AtlasImages } {
  const psd = importPsd(writeFigure(layers), "figure.psd", "h"), images = atlasImages(psd.atlas);
  return { c: testContext(new History(psd.skeleton), images), images };
}

/** The atlas image the runtime draws for `slot`: its attachment's frame (a sequence's keyed one). */
function drawn(doc: Skeleton, images: AtlasImages, slot: string, skin: string | null = null, animation: string | null = null, time = 0): string | null {
  const p = poserCache()(doc, images).pose(skin, animation, Math.fround(time));
  const i = p.rig.data.slots.findIndex((s) => s.name === slot), a = p.rig.attachmentOf(i);
  return a ? p.rig.frameOf(i, a).region?.name ?? null : null;
}

const JOINTS = {
  pelvis: [0, 134], neck: [0, 279], head: [0, 378], "hip.left": [-20, 129], "knee.left": [-20, 76], "ankle.left": [-20, 28],
  "hip.right": [20, 129], "knee.right": [20, 76], "ankle.right": [20, 28], "shoulder.left": [-70, 263], "elbow.left": [-70, 211], "wrist.left": [-70, 158],
  "shoulder.right": [70, 263], "elbow.right": [70, 211], "wrist.right": [70, 158],
};

describe("skins and tints (E5 step 8)", () => {
  it("add_skin and set_skin_image: the skin shows another image in the slot's place, about its centre; only_in_skins empties the default", async () => {
    const { c, images } = open();
    expect(await call(c, "add_skin", { name: "blue" })).toEqual({ skin: "blue", skins: ["default", "blue"], shown: "blue" });
    expect(c.view().skin).toBe("blue");
    expect(c.history!.undoLabel).toBe("AI: add_skin blue");

    await call(c, "set_skin_image", { skin: "blue", layer: "head", image: "body" });
    let doc = c.history!.doc;
    expect(drawn(doc, images, "head")).toBe("head");
    expect(drawn(doc, images, "head", "blue")).toBe("body");
    const own = findAttachment(doc, { skin: "default", slot: "head", key: "head" })!, theirs = findAttachment(doc, { skin: "blue", slot: "head", key: "head" })!;
    expect([theirs.x, theirs.y, theirs.width, theirs.height]).toEqual([own.x, own.y, 100, 150]);

    await call(c, "set_skin_image", { skin: "blue", layer: "head", image: "arm L", only_in_skins: true });
    doc = c.history!.doc;
    expect(drawn(doc, images, "head")).toBeNull();
    expect(drawn(doc, images, "head", "blue")).toBe("arm L");
    // Its place still the head's, read now from the skin itself.
    const moved = findAttachment(doc, { skin: "blue", slot: "head", key: "head" })!;
    expect([moved.x, moved.y, moved.width, moved.height]).toEqual([own.x, own.y, 40, 120]);

    await call(c, "set_skin_image", { skin: "blue", layer: "body", image: "head" });
    await call(c, "set_skin_image", { skin: "blue", layer: "body", image: null });
    expect(drawn(c.history!.doc, images, "body", "blue")).toBe("body");

    expect(await refused(call(c, "set_skin_image", { skin: "default", layer: "head", image: "body" }))).toMatch(/default skin/);
    expect(await refused(call(c, "set_skin_image", { skin: "blue", layer: "head", image: "tail" }))).toMatch(/no atlas image "tail"/);
    expect(await refused(call(c, "set_skin_image", { skin: "blue", layer: "head", image: "body", display: 2 }))).toMatch(/1 display \(head\); display 2/);
  });

  it("set_skin_members: a skin's own bones and constraints are active only while it is shown; remove takes them out", async () => {
    const { c } = open();
    await call(c, "auto_rig", { joints: JOINTS, view: "front" });
    await call(c, "add_skin", { name: "hat" });
    const out = await call(c, "set_skin_members", { skin: "hat", bones: ["head_bone"], constraints: ["shin_left_ik"] });
    expect(out).toEqual({ skin: "hat", bones: ["head_bone"], constraints: ["shin_left_ik"] });
    const active = (skin: string | null) => c.pose(skin, null, 0).find((b) => b.name === "head_bone")!.active;
    expect([active(null), active("hat")]).toEqual([false, true]);
    await call(c, "set_skin_members", { skin: "hat", bones: ["head_bone"], remove: true });
    expect(active(null)).toBe(true);
    expect(await refused(call(c, "set_skin_members", { skin: "hat", constraints: ["nope"] }))).toMatch(/no constraint "nope"/);
  });

  it("set_skin_color and set_tint: Spine's colours, rrggbb taken as opaque, null and a white tint for none", async () => {
    const { c } = open();
    await call(c, "add_skin", { name: "red" });
    expect(await call(c, "set_skin_color", { skin: "red", color: "ff0000" })).toEqual({ skin: "red", color: "ff0000ff" });
    await call(c, "set_skin_color", { skin: "red", color: "ffffffff" });
    expect(c.history!.doc.skins!.find((k) => k.name === "red")!.color).toBe("ffffffff");
    await call(c, "set_skin_color", { skin: "red", color: null });
    expect(c.history!.doc.skins!.find((k) => k.name === "red")!.color).toBeUndefined();
    expect(await refused(call(c, "set_skin_color", { skin: "red", color: "red" }))).toMatch(/not a colour/);

    c.show({ ...c.view(), skin: null });
    expect(await call(c, "set_tint", { layer: "body", color: "808080" })).toEqual({ layer: "body", display: "body", skin: "default", color: "808080ff" });
    expect(findAttachment(c.history!.doc, { skin: "default", slot: "body", key: "body" })!.color).toBe("808080ff");
    await call(c, "set_tint", { layer: "body", color: "ffffff" });
    expect(findAttachment(c.history!.doc, { skin: "default", slot: "body", key: "body" })!.color).toBeUndefined();
    // With a skin shown that has its own image there, that image is tinted.
    await call(c, "set_skin_image", { skin: "red", layer: "body", image: "head" });
    c.show({ ...c.view(), skin: "red" });
    expect(await call(c, "set_tint", { layer: "body", color: "ff000080" })).toMatchObject({ skin: "red", color: "ff000080" });
  });
});

describe("sequences (E5 step 8)", () => {
  const flames = (w = 20) => [...figureLayers(), part("fire_01", 10, 10, 20, 30, [255, 120, 0]), part("fire_02", 40, 10, w, 30, [255, 160, 0]), part("fire_03", 70, 10, 20, 30, [255, 200, 0])];

  it("finds the numbered run around an image", () => {
    expect(numberedRun("fire_02", ["fire_01", "fire_02", "fire_03", "fire_05", "fire_1"])).toEqual({ prefix: "fire_", start: 1, count: 3, digits: 2, at: 2 });
    expect(numberedRun("walk9", ["walk8", "walk9", "walk10", "walk07"])).toEqual({ prefix: "walk", start: 8, count: 3, digits: 0, at: 9 });
    expect(numberedRun("head", ["head"])).toBeNull();
  });

  it("make_sequence and key_sequence: the runtime draws the keyed frame, stepping every `delay` frames", async () => {
    const { c, images } = open(flames());
    const made = await call(c, "make_sequence", { layer: "fire_02" });
    expect(made).toMatchObject({ layer: "fire_02", images: ["fire_01", "fire_02", "fire_03"], setup: 1 });
    expect(drawn(c.history!.doc, images, "fire_02")).toBe("fire_02");
    expect(await refused(call(c, "make_sequence", { layer: "fire_02" }))).toMatch(/already a sequence/);

    await call(c, "new_animation", { name: "burn", frames: 12 });
    await call(c, "key_sequence", { animation: "burn", layer: "fire_02", frame: 0, mode: "loop", delay: 2 });
    const at = (frame: number) => drawn(c.history!.doc, images, "fire_02", null, "burn", frame / 30);
    expect([0, 2, 4, 6].map(at)).toEqual(["fire_01", "fire_02", "fire_03", "fire_01"]);
    await call(c, "key_sequence", { animation: "burn", layer: "fire_02", frame: 8, index: 2 });
    expect([8, 11].map(at)).toEqual(["fire_03", "fire_03"]);
    expect(c.history!.undoLabel).toBe("AI: key_sequence fire_02 at 8");

    await call(c, "key_sequence", { animation: "burn", layer: "fire_02", frame: 8, delete: true });
    expect(at(8)).toBe("fire_02");
    expect(await refused(call(c, "key_sequence", { animation: "burn", layer: "fire_02", frame: 3, delete: true }))).toMatch(/no sequence key at frame 3/);
    expect(await refused(call(c, "key_sequence", { animation: "burn", layer: "fire_02", frame: 0, index: 3 }))).toMatch(/3 images \(0 to 2\)/);
    expect(await refused(call(c, "key_sequence", { animation: "burn", layer: "head", frame: 0 }))).toMatch(/not a sequence/);
  });

  it("refuses a run of mixed sizes, naming the odd image", async () => {
    const { c } = open(flames(24));
    expect(await refused(call(c, "make_sequence", { layer: "fire_01" }))).toMatch(/"fire_02" is 24×30, "fire_01" 20×30/);
  });
});
