import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addRegion, deleteAttachment, findAttachment, renameAttachment, updateAttachment } from "@/edit/attachments";
import { addBone, deleteBone, reparentBone, subtree } from "@/edit/bones";
import { offsetsFor, orderOf } from "@/edit/drawOrder";
import { addSlot, deleteSlot, moveSlot, renameSlot, updateSlot } from "@/edit/slots";
import { readAtlas } from "@/io/atlas";
import { plainJson } from "@/io/json";
import { readSkeleton } from "@/io/skeletonRead";
import { skeletonToJson, writeSkeleton } from "@/io/skeletonWrite";
import { profileIssues } from "@/model/profile";
import type { Skeleton } from "@/model/skeleton";
import { keyTime } from "@/model/timelines";
import { atlasImages, NO_IMAGES } from "@/engine/regions";
import { Rig } from "@/engine/rig";
import { readRig } from "@/engine/rigData";
import { boneMatrix, localUnder, Poser } from "@/ui/stage/posed";
import { compare, TOLERANCE } from "./fixtures/oracle";
import { STICKMAN } from "./fixtures/rigs";
import { SAMPLES } from "./fixtures/samples";

const stickman = () => readSkeleton(readFileSync(join(STICKMAN, "Stickman_IK.json"), "utf8")).skeleton;
const stickmanAtlas = () => readFileSync(join(STICKMAN, "Stickman_IK.atlas.txt"), "utf8");
const raptor = () => readSkeleton(readFileSync(join(SAMPLES, "raptor-pro-and-mask/raptor-pro.json"), "utf8")).skeleton;
/** Every atlas in a sample's folder, as the oracle reads them. */
const atlasOf = (dir: string) => readdirSync(join(SAMPLES, dir)).filter((f) => f.endsWith(".atlas.txt")).map((f) => readFileSync(join(SAMPLES, dir, f), "utf8").trim()).join("\n\n");
const RAPTOR_ATLAS = atlasOf("raptor-pro-and-mask");
const names = (s: Skeleton, k: "bones" | "slots") => (s[k] ?? []).map((x) => x.name);

/** A sound file: the profile holds, it round-trips, and both runtimes pose it alike. */
function sound(s: Skeleton, atlas = ""): void {
  expect(profileIssues(s)).toEqual([]);
  const text = writeSkeleton(s);
  expect(writeSkeleton(readSkeleton(text).skeleton)).toBe(text);
  const { worst } = compare("edited", text, atlas, [0, 0.5, 1]);
  expect(worst.value, worst.where).toBeLessThanOrEqual(TOLERANCE);
}

/** Each animation's draw order at each of its draw order keys, by slot name, as the engine plays it. */
function drawOrders(s: Skeleton): Record<string, string[][]> {
  const rig = new Rig(readRig(plainJson(skeletonToJson(s)), NO_IMAGES));
  const out: Record<string, string[][]> = {};
  for (const a of s.animations ?? []) {
    if (!a.drawOrder) continue;
    out[a.name] = a.drawOrder.map((k) => {
      rig.setupPose();
      rig.apply(rig.animation(a.name)!, Math.fround(keyTime(k)), false);
      return rig.drawOrder.map((i) => rig.data.slots[i]!.name);
    });
  }
  return out;
}

describe("draw order offsets", () => {
  it("read and write any order of the slots, as the format builds it", () => {
    const slots = ["a", "b", "c", "d", "e", "f"];
    let seed = 7;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let n = 0; n < 200; n++) {
      const order = [...slots].sort(() => rand() - 0.5);
      expect(orderOf(slots, offsetsFor(slots, order))).toEqual(order);
    }
    expect(orderOf(slots, undefined)).toEqual(slots);
  });
});

describe("bones", () => {
  it("adds a bone after its parent's other descendants, refusing a second root or a stranger", () => {
    const s = addBone("tail", "hips", { length: 20 })(stickman());
    const bones = names(s, "bones"), i = bones.indexOf("tail");
    expect(bones.slice(0, i)).toEqual(expect.arrayContaining(subtree(stickman(), "hips")));
    expect(() => addBone("x", null)(stickman())).toThrow(/has its root/);
    expect(() => addBone("x", "nope")(stickman())).toThrow(/no bone "nope"/);
    expect(() => addBone("hips", "root")(stickman())).toThrow(/already a bone/);
    expect(addBone("root", null)(readSkeleton("{}").skeleton).bones).toHaveLength(1);
    sound(s, stickmanAtlas());
  });
  it("deletes a bone with its descendants and their slots, skin entries and timelines", () => {
    const s = deleteBone("head")(stickman());
    expect(names(s, "bones")).not.toContain("head_art");
    expect(names(s, "slots").filter((n) => ["head", "head_art"].includes(n))).toEqual([]);
    expect(s.animations!.flatMap((a) => a.bones ?? []).map((g) => g.name).filter((n) => n.startsWith("head"))).toEqual([]);
    expect(s.skins!.flatMap((k) => k.attachments ?? []).map((ss) => ss.slot)).not.toContain("head_art");
    sound(s, stickmanAtlas());
  });
  it.each([
    ["the root", "root", /root bone cannot/],
    ["an IK target", "foot_near_target", /ik constraint ".*" uses "foot_near_target"/],
    ["a bone with a constrained child", "leg_near_thigh", /constraint/],
  ])("refuses to delete %s", (_, bone, why) => {
    expect(() => deleteBone(bone)(stickman())).toThrow(why);
  });
  it("reparents a bone keeping it where it was, parents before children, never under itself", () => {
    const s0 = stickman(), images = atlasImages(readAtlas(stickmanAtlas()));
    const p = new Poser(s0, images).pose(null, null, 0);
    const i = p.bones.get("head")!, before = boneMatrix(p, i);
    const local = localUnder(p, i, p.bones.get("hips")!);
    const s = reparentBone("head", "hips", local)(s0);
    const bones = s.bones!, at = (n: string) => bones.findIndex((b) => b.name === n);
    for (const b of bones) if (b.parent !== undefined) expect(at(b.parent)).toBeLessThan(at(b.name));
    const q = new Poser(s, images).pose(null, null, 0), after = boneMatrix(q, q.bones.get("head")!);
    after.forEach((v, k) => expect(v).toBeCloseTo(before[k]!, 1));
    expect(() => reparentBone("chest", "head")(s0)).toThrow(/own descendant/);
    expect(() => reparentBone("root", "hips")(s0)).toThrow(/root bone has no parent/);
    sound(s, stickmanAtlas());
  });
});

describe("slots and the draw order", () => {
  const firstKeyed = (s: Skeleton) => s.animations!.find((a) => a.drawOrder)!.drawOrder!.flatMap((k) => k.offsets ?? []).map((o) => o.slot!)[0]!;
  it("moving a slot keeps every draw order key drawing the same slots in the same order", () => {
    const s0 = raptor(), slot = firstKeyed(s0), before = drawOrders(s0);
    for (const to of [0, 5, s0.slots!.length - 1]) {
      const s = moveSlot(slot, to)(s0);
      expect(names(s, "slots").indexOf(slot)).toBe(to);
      expect(drawOrders(s)).toEqual(before);
      expect(profileIssues(s)).toEqual([]);
    }
  });
  it("renaming a slot follows it everywhere, the draw order keys too", () => {
    const s0 = raptor(), slot = firstKeyed(s0);
    const s = renameSlot(slot, "renamed")(s0);
    const want = Object.fromEntries(Object.entries(drawOrders(s0)).map(([k, v]) => [k, v.map((o) => o.map((n) => (n === slot ? "renamed" : n)))]));
    expect(drawOrders(s)).toEqual(want);
    expect(names(s, "slots")).not.toContain(slot);
    expect(s.skins!.flatMap((k) => k.attachments ?? []).map((ss) => ss.slot)).not.toContain(slot);
    expect(s.animations!.flatMap((a) => [...(a.slots ?? []).map((g) => g.name), ...(a.drawOrder ?? []).flatMap((k) => (k.offsets ?? []).map((o) => o.slot))])).not.toContain(slot);
    sound(s, RAPTOR_ATLAS);
  });
  it("deleting a slot drops it from the keys; the others keep their order", () => {
    const s0 = raptor(), slot = firstKeyed(s0);
    const s = deleteSlot(slot)(s0);
    const want = Object.fromEntries(Object.entries(drawOrders(s0)).map(([k, v]) => [k, v.map((o) => o.filter((n) => n !== slot))]));
    expect(drawOrders(s)).toEqual(want);
    sound(s, RAPTOR_ATLAS);
  });
  it("adding a slot under a keyed draw order puts it beside its setup neighbour in every key", () => {
    const s0 = raptor(), bone = s0.bones![1]!.name;
    const s = addSlot("new", bone, 3)(s0);
    for (const orders of Object.values(drawOrders(s))) {
      for (const o of orders) expect(o.indexOf("new")).toBe(o.indexOf(names(s, "slots")[2]!) + 1);
    }
    sound(s, RAPTOR_ATLAS);
  });
  it("keeps a draw order folder's keys too, its slots re-sorted to the new setup order", () => {
    const s0 = readSkeleton(JSON.stringify({
      bones: [{ name: "root" }], slots: ["a", "b", "c", "d"].map((name) => ({ name, bone: "root" })),
      animations: { flip: { drawOrderFolder: [{ slots: ["b", "c", "d"], keys: [{ offsets: [{ slot: "b", offset: 2 }] }] }] } },
    })).skeleton;
    const s = moveSlot("d", 1)(s0);
    const f = s.animations![0]!.drawOrderFolder![0]!;
    expect(f.slots).toEqual(["d", "b", "c"]);
    expect(orderOf(f.slots!, f.keys![0]!.offsets)).toEqual(orderOf(["b", "c", "d"], [{ slot: "b", offset: 2, extra: new Map() }]));
  });
  it.each([
    ["a path constraint follows", "hero", "Hero/hero-pro.json"],
  ])("refuses to delete a slot %s", (_, __, file) => {
    const s0 = readSkeleton(readFileSync(join(SAMPLES, file), "utf8")).skeleton;
    const path = s0.constraints!.find((c) => c.type === "path")!;
    expect(() => deleteSlot((path as { slot: string }).slot)(s0)).toThrow(/path constraint/);
  });
  it("refuses to delete a slot a clipping ends at", () => {
    const s0 = readSkeleton(readFileSync(join(SAMPLES, "spineboy-pro/spineboy-pro.json"), "utf8")).skeleton;
    const end = s0.skins!.flatMap((k) => k.attachments ?? []).flatMap((ss) => ss.entries).find((e) => e.attachment.type === "clipping")!.attachment.end!;
    expect(() => deleteSlot(end)(s0)).toThrow(/clipping/);
  });
  it.each([
    [{ bone: "nope" }, /no bone/],
    [{ color: "red" }, /8 hex/],
    [{ dark: "ffffffff" }, /6 hex/],
    [{ blend: "overlay" }, /blend mode/],
    [{ attachment: "nothing" }, /no attachment "nothing"/],
  ])("refuses a slot field %j", (patch, why) => {
    expect(() => updateSlot("torso", patch)(stickman())).toThrow(why);
  });
  it("sets slot fields, and back to the default removes the key", () => {
    let s = updateSlot("torso", { color: "ff000080", blend: "additive" })(stickman());
    expect(s.slots!.find((x) => x.name === "torso")).toMatchObject({ color: "ff000080", blend: "additive" });
    s = updateSlot("torso", { blend: undefined })(s);
    expect("blend" in s.slots!.find((x) => x.name === "torso")!).toBe(false);
    sound(s, stickmanAtlas());
  });
});

describe("attachments", () => {
  const R = { skin: "default", slot: "torso", key: "torso" };
  it("adds a region, creating the default skin in an empty skeleton", () => {
    const s0 = addSlot("body", "root")(addBone("root", null)(readSkeleton('{"skeleton":{"hash":"x","spine":"4.3.0"}}').skeleton));
    const s = addRegion({ skin: "default", slot: "body", key: "head" }, { width: 59, height: 54 })(s0);
    expect(findAttachment(s, { skin: "default", slot: "body", key: "head" })).toMatchObject({ width: 59, height: 54 });
    expect(() => addRegion({ skin: "default", slot: "body", key: "head" }, { width: 1, height: 1 })(s)).toThrow(/already has/);
    expect(() => addRegion({ skin: "default", slot: "body", key: "x" }, { width: 0, height: 1 })(s)).toThrow(/above 0/);
    sound(updateSlot("body", { attachment: "head" })(s), stickmanAtlas());
  });
  it("renames a key everywhere and keeps its image: the pose does not change", () => {
    const s0 = stickman();
    const s = renameAttachment(R, "chest_art")(s0);
    expect(findAttachment(s, { ...R, key: "chest_art" })).toMatchObject({ path: "torso" });
    expect(s.slots!.find((x) => x.name === "torso")!.attachment).toBe("chest_art");
    const v = (d: Skeleton) => Array.from(new Poser(d, atlasImages(readAtlas(stickmanAtlas()))).pose(null, null, 0).draw.slots.map((x) => x.frame.region.name));
    expect(v(s)).toEqual(v(s0));
    sound(s, stickmanAtlas());
  });
  it("deletes an attachment with its deform timelines, and the slot it showed in shows nothing", () => {
    const s0 = readSkeleton(readFileSync(join(SAMPLES, "Dragon/dragon.json"), "utf8")).skeleton;
    const st = s0.animations!.flatMap((a) => a.attachments ?? [])[0]!, sl = st.slots[0]!;
    const r = { skin: st.skin, slot: sl.slot, key: sl.attachments[0]!.name };
    const s = deleteAttachment(r)(s0);
    expect(findAttachment(s, r)).toBeUndefined();
    const left = s.animations!.flatMap((a) => a.attachments ?? []).filter((x) => x.skin === r.skin).flatMap((x) => x.slots).filter((x) => x.slot === r.slot).flatMap((x) => x.attachments.map((g) => g.name));
    expect(left).not.toContain(r.key);
    sound(s, atlasOf("Dragon"));
  });
  it("refuses to delete a linked mesh's source", () => {
    const s0 = readSkeleton(readFileSync(join(SAMPLES, "Goblins/goblins.json"), "utf8")).skeleton;
    const sk = s0.skins!.find((k) => k.attachments?.some((ss) => ss.entries.some((e) => e.attachment.source !== undefined)))!;
    const ss = sk.attachments!.find((x) => x.entries.some((e) => e.attachment.source !== undefined))!;
    const linked = ss.entries.find((e) => e.attachment.source !== undefined)!.attachment;
    expect(() => deleteAttachment({ skin: linked.skin ?? "default", slot: linked.slot ?? ss.slot, key: linked.source! })(s0)).toThrow(/linked mesh/);
  });
  it("sets fields, refusing a size of 0", () => {
    const s = updateAttachment(R, { x: 3, rotation: 10 })(stickman());
    expect(findAttachment(s, R)).toMatchObject({ x: 3, rotation: 10 });
    expect(() => updateAttachment(R, { width: 0 })(stickman())).toThrow(/above 0/);
    sound(s, stickmanAtlas());
  });
});
