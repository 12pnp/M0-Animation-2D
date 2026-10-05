import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { deleteBone, updateBone } from "@/edit/bones";
import { addConstraint, deleteConstraint, findConstraint, moveConstraint, renameConstraint, updateConstraint } from "@/edit/constraints";
import { setSkinMember } from "@/edit/skins";
import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import { constraintMix, constraintValue } from "@/model/defaults";
import { profileIssues } from "@/model/profile";
import type { ConstraintType, IkConstraint, Skeleton, TransformConstraint } from "@/model/skeleton";
import { atlasImages } from "@/engine/regions";
import { newConstraint } from "@/ui/panels/newConstraint";
import { boneMatrix, Poser } from "@/ui/stage/posed";
import { compare, TOLERANCE } from "./fixtures/oracle";
import { SAMPLES } from "./fixtures/samples";

const sample = (dir: string, file: string) => ({
  doc: readSkeleton(readFileSync(join(SAMPLES, dir, file), "utf8")).skeleton,
  atlas: readdirSync(join(SAMPLES, dir)).filter((f) => f.endsWith(".atlas.txt")).map((f) => readFileSync(join(SAMPLES, dir, f), "utf8").trim()).join("\n\n"),
});
const spineboy = () => sample("spineboy-pro", "spineboy-pro.json");
const stretchy = () => sample("Stretchyman", "stretchyman.json");
const hero = () => sample("Hero", "hero-pro.json");
const circus = () => sample("celestial-circus", "celestial-circus-pro.json");

/** The profile holds, the file round-trips, and both runtimes pose it alike. */
function sound(s: Skeleton, atlas: string): void {
  expect(profileIssues(s)).toEqual([]);
  const text = writeSkeleton(s);
  expect(writeSkeleton(readSkeleton(text).skeleton)).toBe(text);
  const { worst } = compare("edited", text, atlas, [0, 0.5]);
  expect(worst.value, worst.where).toBeLessThanOrEqual(TOLERANCE);
}

/** Every bone's setup world matrix, by name. */
function setupWorld(s: Skeleton, atlas: string): Map<string, number[]> {
  const p = new Poser(s, atlasImages(readAtlas(atlas))).pose(null, null, 0);
  return new Map([...p.bones].map(([n, i]) => [n, [...boneMatrix(p, i)]]));
}

/** The names of kind `type` in skins' lists and animations' timelines. */
function namesOf(s: Skeleton, type: ConstraintType): string[] {
  const skins = (s.skins ?? []).flatMap((k) => (k[type] ?? []).map((n) => `skin ${k.name}: ${n}`));
  const anims = (s.animations ?? []).flatMap((a) => ((a[type] ?? []) as readonly { name: string }[]).map((g) => `${a.name}: ${g.name}`));
  return [...skins, ...anims].sort();
}

describe("constraint edits", () => {
  it("renames a constraint in the skins that turn it on and the animations that key it", () => {
    const { doc, atlas } = spineboy();
    for (const type of ["ik", "transform"] as const) {
      const keyed = doc.animations!.flatMap((a) => a[type] ?? []).map((l) => l.name)[0]!;
      const before = namesOf(doc, type);
      expect(before.some((n) => n.endsWith(`: ${keyed}`))).toBe(true);
      const s = renameConstraint({ type, name: keyed }, "renamed")(doc);
      expect(namesOf(s, type)).toEqual(before.map((n) => n.replace(new RegExp(`: ${keyed}$`), ": renamed")).sort());
      expect(findConstraint(s, { type, name: keyed })).toBeUndefined();
      sound(s, atlas);
    }
    expect(() => renameConstraint({ type: "ik", name: "aim-ik" }, "")(doc)).toThrow(/needs a name/);
  });
  it("renames path and physics constraints with their timelines; the global physics group stays", () => {
    const h = hero();
    const path = h.doc.constraints!.find((c) => c.type === "path")!.name;
    sound(renameConstraint({ type: "path", name: path }, "p2")(h.doc), h.atlas);
    const { doc, atlas } = circus();
    const keyed = doc.animations!.flatMap((a) => a.physics ?? []).map((g) => g.name).find((n) => n !== "")!;
    const s = renameConstraint({ type: "physics", name: keyed }, "renamed")(doc);
    expect(namesOf(s, "physics")).toEqual(namesOf(doc, "physics").map((n) => n.replace(new RegExp(`: ${keyed}$`), ": renamed")).sort());
    sound(s, atlas);
  });
  it("deletes a constraint with its timelines and its place in every skin", () => {
    const { doc, atlas } = spineboy();
    const keyed = doc.animations!.flatMap((a) => a.ik ?? []).map((l) => l.name)[0]!;
    const s = deleteConstraint({ type: "ik", name: keyed })(doc);
    expect(namesOf(s, "ik").filter((n) => n.endsWith(`: ${keyed}`))).toEqual([]);
    expect(s.constraints!.length).toBe(doc.constraints!.length - 1);
    sound(s, atlas);
    // A bone a constraint uses can go once the constraint has.
    const target = (doc.constraints!.find((c) => c.type === "ik" && c.name === keyed) as { target: string }).target;
    expect(() => deleteBone(target)(doc)).toThrow(/Delete the constraint first/);
  });
  it("reorders the update order, and both runtimes apply the new order alike", () => {
    const { doc, atlas } = stretchy();
    const last = doc.constraints!.at(-1)!;
    const s = moveConstraint(last, 0)(doc);
    expect(s.constraints![0]).toBe(last);
    expect(moveConstraint(last, doc.constraints!.length - 1)(doc)).toBe(doc);
    sound(s, atlas);
  });
  it("sets values, dropping defaults and refusing broken references", () => {
    const { doc, atlas } = spineboy();
    const ik = doc.constraints!.find((c): c is IkConstraint => c.type === "ik" && c.bones?.length === 2)!;
    const r = { type: "ik" as const, name: ik.name };
    const s = updateConstraint(r, { mix: 0.5, bendPositive: false, softness: 10 })(doc);
    expect(findConstraint(s, r)).toMatchObject({ mix: 0.5, bendPositive: false, softness: 10 });
    sound(s, atlas);
    expect(updateConstraint(r, { mix: undefined })(s)).not.toHaveProperty(["constraints", doc.constraints!.indexOf(ik), "mix"]);
    expect(() => updateConstraint(r, { bones: [] })(doc)).toThrow(/one bone or two/);
    expect(() => updateConstraint(r, { bones: [ik.bones![1]!, ik.bones![0]!] })(doc)).toThrow(/not a child/);
    expect(() => updateConstraint(r, { target: ik.bones![0] })(doc)).toThrow(/own target/);
    expect(() => updateConstraint(r, { target: ik.bones![1] })(doc)).toThrow(/own target/);
    expect(() => updateConstraint(r, { target: "nope" })(doc)).toThrow(/no bone/);
    const t = doc.constraints!.find((c): c is TransformConstraint => c.type === "transform")!;
    expect(() => updateConstraint({ type: "transform", name: t.name }, { source: t.bones![0] })(doc)).toThrow(/own source/);
    // Bones taken away leave the key, empty: spine-core's reader needs it.
    const bare = updateConstraint({ type: "transform", name: t.name }, { bones: undefined })(doc);
    expect(findConstraint(bare, t)).toHaveProperty("bones", []);
    sound(bare, atlas);
  });
  it("marks a constraint skin-required; a skin then turns it on", () => {
    const { doc, atlas } = spineboy();
    const ik = doc.constraints!.find((c) => c.type === "ik")!;
    const skin = doc.skins![0]!.name;
    let s = updateConstraint({ type: "ik", name: ik.name }, { skin: true })(doc);
    s = setSkinMember(skin, "ik", ik.name, true)(s);
    expect(s.skins![0]!.ik).toContain(ik.name);
    sound(s, atlas);
  });
  it("refuses a name its kind already has, and allows it in another kind", () => {
    const { doc } = spineboy();
    const ik = doc.constraints!.find((c) => c.type === "ik")!;
    expect(() => addConstraint({ ...ik })(doc)).toThrow(/already an IK constraint/);
    const t = doc.constraints!.find((c) => c.type === "transform")!;
    expect(addConstraint({ ...t, name: ik.name })(doc).constraints!.length).toBe(doc.constraints!.length + 1);
  });
});

describe("transform mixes", () => {
  it("read as the runtimes read them: 0 without a target of their kind, mixY following mixX", () => {
    const base: TransformConstraint = { type: "transform", name: "t", extra: new Map() };
    const to = (...kinds: string[]): TransformConstraint => ({ ...base, properties: [{ from: "x", to: kinds.map((k) => ({ to: k, extra: new Map() })), extra: new Map() }] });
    expect(constraintMix(to("rotate"), "mixX")).toBe(0);
    expect(constraintMix({ ...to("rotate"), mixRotate: 0.3 }, "mixRotate")).toBe(0.3);
    expect(constraintMix({ ...to("x", "y"), mixX: 0.4 }, "mixY")).toBe(0.4);
    expect(constraintMix({ ...to("y"), mixX: 0.4 }, "mixY")).toBe(0);
    expect(constraintMix({ ...to("scaleX", "scaleY") }, "mixScaleY")).toBe(1);
    expect(constraintValue({ type: "path", name: "p", mixX: 0.2, extra: new Map() }, "mixY")).toBe(0.2);
  });
});

describe("new constraints", () => {
  const from = { bone: null, slot: null, skin: null, animation: null };
  it("of every kind leave the setup pose as it was, and both runtimes agree", () => {
    const { doc, atlas } = hero();
    const images = atlasImages(readAtlas(atlas));
    const before = setupWorld(doc, atlas);
    const bone = doc.bones!.find((b) => b.parent !== undefined && (b.length ?? 0) > 0 && !doc.constraints!.some((c) => "bones" in c && (c.bones as readonly string[] | undefined)?.includes(b.name)))!.name;
    const pathSlot = doc.skins!.flatMap((k) => (k.attachments ?? []).filter((ss) => ss.entries.some((e) => e.attachment.type === "path")).map((ss) => ss.slot))[0]!;
    let s = doc;
    const made: string[] = [];
    for (const type of ["ik", "transform", "path", "physics", "slider"] as const) {
      const { edit, ref } = newConstraint(s, images, type, { ...from, bone, slot: pathSlot, animation: doc.animations![0]!.name });
      s = edit(s);
      expect(findConstraint(s, ref)).toBeDefined();
      made.push(`${ref.type}:${ref.name}`);
    }
    expect(s.constraints!.slice(-5).map((c) => `${c.type}:${c.name}`)).toEqual(made);
    const after = setupWorld(s, atlas);
    for (const [n, m] of before) for (let k = 0; k < 6; k++) expect(after.get(n)![k], `${n}[${k}]`).toBeCloseTo(m[k]!, 2);
    sound(s, atlas);
  });
  it("an IK aims at a new target at the bone's tip, and bends it once the target moves", () => {
    const { doc, atlas } = hero();
    const images = atlasImages(readAtlas(atlas));
    const bone = doc.bones!.find((b) => b.parent !== undefined && (b.length ?? 0) > 20)!.name;
    const { edit, ref } = newConstraint(doc, images, "ik", { ...from, bone });
    const s = edit(doc);
    const ik = findConstraint(s, ref)!;
    expect(ik).toMatchObject({ bones: [bone], target: `${bone}-target` });
    expect(updateConstraint(ref, {})(s)).toBe(s);
    sound(s, atlas);
    // Moving the target turns the bone toward it.
    const t = s.bones!.find((b) => b.name === `${bone}-target`)!;
    const moved = updateBone(t.name, { x: (t.x ?? 0) + 40, y: (t.y ?? 0) + 40 })(s);
    expect(setupWorld(moved, atlas).get(bone)!.slice(0, 4)).not.toEqual(setupWorld(s, atlas).get(bone)!.slice(0, 4));
    sound(moved, atlas);
  });
  it("say what to select when the selection does not fit", () => {
    const { doc, atlas } = spineboy();
    const images = atlasImages(readAtlas(atlas));
    expect(() => newConstraint(doc, images, "ik", from)).toThrow(/Select the bone/);
    expect(() => newConstraint(doc, images, "ik", { ...from, bone: "root" })).toThrow(/root bone cannot be bent/);
    expect(() => newConstraint(doc, images, "transform", { ...from, bone: "root" })).toThrow(/no parent/);
    expect(() => newConstraint(doc, images, "path", { ...from, slot: doc.slots![0]!.name })).toThrow(/no path attachment/);
  });
  it("a slider at mix 1 plays its animation at its time, alike in both runtimes", () => {
    const { doc, atlas } = spineboy();
    const images = atlasImages(readAtlas(atlas));
    const { edit, ref: made } = newConstraint(doc, images, "slider", { ...from, animation: "aim" });
    const ref = { type: "slider" as const, name: made.name };
    const s = updateConstraint(ref, { mix: 1, time: 0.2 })(edit(doc));
    expect(setupWorld(s, atlas)).not.toEqual(setupWorld(doc, atlas));
    sound(s, atlas);
    expect(() => updateConstraint(ref, { animation: "nope" })(s)).toThrow(/no animation/);
    expect(() => updateConstraint(ref, { bone: "root" })(s)).toThrow(/property it reads/);
  });
});
