import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addAnimation } from "@/edit/animations";
import { type AttachmentRef, findAttachment } from "@/edit/attachments";
import { keyConstraint, keyPhysicsReset } from "@/edit/constraintKeys";
import { deformWithVertexAt, keyDeform } from "@/edit/deformKeys";
import { setKey } from "@/edit/keys";
import { regionToMesh } from "@/edit/mesh";
import { type BoneWorlds, isWeighted } from "@/edit/meshLayout";
import { readAtlas } from "@/io/atlas";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import { profileIssues } from "@/model/profile";
import type { ConstraintType, Skeleton } from "@/model/skeleton";
import { keysAt, keyTime } from "@/model/timelines";
import { atlasImages, type AtlasImages } from "@/engine/regions";
import { boneMatrix, constraintNow, Poser } from "@/ui/stage/posed";
import { compare, TOLERANCE } from "./fixtures/oracle";
import { SAMPLES } from "./fixtures/samples";

const sample = (dir: string, file: string) => {
  const atlas = readdirSync(join(SAMPLES, dir)).filter((f) => f.endsWith(".atlas.txt")).map((f) => readFileSync(join(SAMPLES, dir, f), "utf8").trim()).join("\n\n");
  return { doc: readSkeleton(readFileSync(join(SAMPLES, dir, file), "utf8")).skeleton, atlas, images: atlasImages(readAtlas(atlas)) };
};

function sound(s: Skeleton, atlas: string): void {
  expect(profileIssues(s)).toEqual([]);
  const text = writeSkeleton(s);
  expect(writeSkeleton(readSkeleton(text).skeleton)).toBe(text);
  const { worst } = compare("keyed", text, atlas, [0, 0.3, 0.6]);
  expect(worst.value, worst.where).toBeLessThanOrEqual(TOLERANCE);
}

/** The constraint's animated values at `time` of `anim`. */
function now(s: Skeleton, images: AtlasImages, anim: string, type: ConstraintType, name: string, time: number, skin: string | null = null) {
  const i = s.constraints!.findIndex((c) => c.type === type && c.name === name);
  return constraintNow(new Poser(s, images).pose(skin, anim, Math.fround(time)), i)!;
}

/** An animation that keys constraint `type` `name`, and a time between two of its keys (or after its only one). */
function keyedAt(s: Skeleton, type: ConstraintType, name: string): { anim: string; time: number } {
  for (const a of s.animations ?? []) {
    const lists = type === "ik" || type === "transform" ? [keysAt(a, { section: type, owner: name })] : ((a[type] ?? []).find((g) => g.name === name)?.timelines.map((t) => t.keys) ?? []);
    for (const keys of lists) if (keys && keys.length >= 2) return { anim: a.name, time: (keyTime(keys[0]!) + keyTime(keys[1]!)) / 2 };
  }
  throw new Error(`no keys for ${name}`);
}

/** Every value but `field` the same; `field` as keyed. */
function expectOnly(before: Record<string, number | boolean>, after: Record<string, number | boolean>, field: string, value: number | boolean): void {
  for (const [k, v] of Object.entries(before)) {
    if (k === field) continue;
    if (typeof v === "number") expect(after[k] as number, k).toBeCloseTo(v, 3);
    else expect(after[k], k).toBe(v);
  }
  if (typeof value === "number") expect(after[field] as number).toBeCloseTo(value, 3);
  else expect(after[field]).toBe(value);
}

describe("constraint keys", () => {
  it("IK: keying one value between keys keeps the others where they were there", () => {
    // The first sample with an IK constraint keyed at least twice in one animation.
    const { doc, atlas, images } = [sample("spineboy-pro", "spineboy-pro.json"), sample("raptor-pro-and-mask", "raptor-pro.json"), sample("Stretchyman", "stretchyman.json")]
      .find((x) => x.doc.constraints!.some((c) => c.type === "ik" && x.doc.animations!.some((a) => (keysAt(a, { section: "ik", owner: c.name })?.length ?? 0) >= 2)))!;
    const ik = doc.constraints!.find((c) => c.type === "ik" && doc.animations!.some((a) => (keysAt(a, { section: "ik", owner: c.name })?.length ?? 0) >= 2))!;
    const { anim, time } = keyedAt(doc, "ik", ik.name);
    const before = now(doc, images, anim, "ik", ik.name, time);
    const s = keyConstraint(anim, { type: "ik", name: ik.name }, "mix", 0.3, before, time)(doc);
    expectOnly(before, now(s, images, anim, "ik", ik.name, time), "mix", 0.3);
    const bent = keyConstraint(anim, { type: "ik", name: ik.name }, "bendPositive", !before.bendPositive, before, time)(doc);
    expectOnly(before, now(bent, images, anim, "ik", ik.name, time), "bendPositive", !before.bendPositive);
    sound(s, atlas);
  });
  it("IK: a value keyed back to its default leaves the key without it", () => {
    const { doc, images } = sample("spineboy-pro", "spineboy-pro.json");
    const name = doc.constraints!.find((c) => c.type === "ik")!.name;
    let s = addAnimation("k")(doc);
    s = setKey("k", { section: "ik", owner: name }, 0, { mix: 0.5, softness: 3 })(s);
    const n = now(s, images, "k", "ik", name, 0);
    s = keyConstraint("k", { type: "ik", name }, "mix", 1, n, 0)(s);
    expect(keysAt(s.animations!.at(-1)!, { section: "ik", owner: name })![0]).not.toHaveProperty("mix");
    expect(keysAt(s.animations!.at(-1)!, { section: "ik", owner: name })![0]).toMatchObject({ softness: 3 });
  });
  it("transform: all six mixes in one key; mixY left out when it equals mixX, mixScaleY when 1", () => {
    const { doc, atlas, images } = sample("spineboy-pro", "spineboy-pro.json");
    const t = doc.constraints!.find((c) => c.type === "transform")!;
    let s = addAnimation("k")(doc);
    const before = now(s, images, "k", "transform", t.name, 0);
    s = keyConstraint("k", { type: "transform", name: t.name }, "mixX", 0.4, { ...before, mixY: 0.4 }, 0)(s);
    const key = keysAt(s.animations!.at(-1)!, { section: "transform", owner: t.name })![0]!;
    expect(key).toMatchObject({ mixX: 0.4 });
    expect(key).not.toHaveProperty("mixY");
    // mixScaleY's key default is 1: written only when it is not 1 here.
    if (before.mixScaleY === 1) expect(key).not.toHaveProperty("mixScaleY"); else expect(key.mixScaleY).toBe(before.mixScaleY);
    expectOnly({ ...before, mixY: 0.4 }, now(s, images, "k", "transform", t.name, 0), "mixX", 0.4);
    sound(s, atlas);
  });
  it("path, physics and slider: their own timelines; physics Reset is a key with only a time", () => {
    const hero = sample("Hero", "hero-pro.json");
    const p = hero.doc.constraints!.find((c) => c.type === "path")!;
    let s = addAnimation("k")(hero.doc);
    const pb = now(s, hero.images, "k", "path", p.name, 0);
    s = keyConstraint("k", { type: "path", name: p.name }, "mixRotate", 0.25, pb, 0)(s);
    s = keyConstraint("k", { type: "path", name: p.name }, "position", 0.5, pb, 0.2)(s);
    expectOnly(pb, now(s, hero.images, "k", "path", p.name, 0), "mixRotate", 0.25);
    expect(now(s, hero.images, "k", "path", p.name, 0.2).position as number).toBeCloseTo(0.5, 4);
    sound(s, hero.atlas);

    const circus = sample("celestial-circus", "celestial-circus-pro.json");
    const ph = circus.doc.constraints!.find((c) => c.type === "physics")!;
    let c = addAnimation("k")(circus.doc);
    const phb = now(c, circus.images, "k", "physics", ph.name, 0);
    c = keyConstraint("k", { type: "physics", name: ph.name }, "mass", 3, phb, 0)(c);
    c = keyPhysicsReset("k", ph.name, 0.5)(c);
    expect(now(c, circus.images, "k", "physics", ph.name, 0).mass as number).toBeCloseTo(3, 4);
    const group = c.animations!.at(-1)!.physics!.find((g) => g.name === ph.name)!;
    expect(group.timelines.map((t) => t.name)).toEqual(["mass", "reset"]);
    expect(group.timelines[1]!.keys[0]).toEqual({ time: 0.5, extra: new Map() });
    sound(c, circus.atlas);

    // A slider on spineboy-pro playing `aim`; its time keyed.
    const sb = sample("spineboy-pro", "spineboy-pro.json");
    let d = { ...sb.doc, constraints: [...sb.doc.constraints!, { type: "slider" as const, name: "sl", animation: "aim", extra: new Map() }] } as Skeleton;
    d = addAnimation("k")(d);
    const sl = now(d, sb.images, "k", "slider", "sl", 0);
    d = keyConstraint("k", { type: "slider", name: "sl" }, "time", 0.3, sl, 0)(d);
    expect(now(d, sb.images, "k", "slider", "sl", 0).time as number).toBeCloseTo(0.3, 4);
    sound(d, sb.atlas);
  });
  it("refuse what does not animate", () => {
    const { doc } = sample("spineboy-pro", "spineboy-pro.json");
    const ik = doc.constraints!.find((c) => c.type === "ik")!;
    const s = addAnimation("k")(doc);
    expect(() => keyConstraint("k", { type: "ik", name: ik.name }, "target", 1, {}, 0)(s)).toThrow(/setup pose/);
    expect(() => keyConstraint("k", { type: "ik", name: "nope" }, "mix", 1, {}, 0)(s)).toThrow(/no such constraint/);
  });
});

describe("deform keys", () => {
  /** World matrices of every bone, and the slot's drawn vertices, at `time` of `anim`. */
  function posedAt(s: Skeleton, images: AtlasImages, r: AttachmentRef, anim: string, time: number) {
    const p = new Poser(s, images).pose(r.skin === "default" ? null : r.skin, anim, Math.fround(time));
    const bones: BoneWorlds = s.bones!.map((b) => [...boneMatrix(p, p.bones.get(b.name)!)]);
    const slot = p.rig.data.slots.findIndex((x) => x.name === r.slot);
    const att = p.rig.attachmentOf(slot)!;
    const n = (att as { vertexCount?: number; vertices: ArrayLike<number> }).vertexCount ?? 0;
    const world = new Float64Array(n * 2);
    p.rig.vertexWorld(slot, att as never, 0, n * 2, world, 0);
    return { bones, world: [...world], deform: p.rig.deform[slot] ? [...p.rig.deform[slot]!] : null, slotBone: s.bones!.findIndex((b) => b.name === s.slots!.find((x) => x.name === r.slot)!.bone) };
  }

  /** Drag vertex `i` of `r` by (dx, dy) in the world at `time`, as the stage keys it. */
  function drag(s: Skeleton, images: AtlasImages, r: AttachmentRef, anim: string, time: number, i: number, dx: number, dy: number) {
    const at = posedAt(s, images, r, anim, time);
    const off = deformWithVertexAt(findAttachment(s, r)!, at.deform, at.bones, at.slotBone, i, at.world[i * 2]! + dx, at.world[i * 2 + 1]! + dy);
    return { s: keyDeform(anim, r, time, off)(s), before: at.world };
  }

  for (const [label, dir, file, weighted] of [["unweighted", "spineboy-pro", "spineboy-pro.json", false], ["weighted", "spineboy-pro", "spineboy-pro.json", true]] as const) {
    it(`${label}: the dragged vertex goes where it was dragged at that time, the others stay`, () => {
      const { doc, atlas, images } = sample(dir, file);
      let s = doc, r: AttachmentRef;
      if (weighted) {
        r = (() => {
          for (const k of s.skins!) for (const ss of k.attachments ?? []) for (const e of ss.entries) {
            if (e.attachment.type === "mesh" && isWeighted(e.attachment) && s.slots!.find((x) => x.name === ss.slot)?.attachment === e.key && k.name === "default") return { skin: k.name, slot: ss.slot, key: e.key };
          }
          throw new Error("none");
        })();
      } else {
        const slot = s.slots!.find((x) => x.attachment && s.skins![0]!.attachments!.find((ss) => ss.slot === x.name)?.entries.find((e) => e.key === x.attachment && (e.attachment.type ?? "region") === "region"))!;
        r = { skin: "default", slot: slot.name, key: slot.attachment! };
        s = regionToMesh(r)(s);
      }
      s = addAnimation("k")(s);
      const first = drag(s, images, r, "k", 0.2, 1, 12, -7);
      const after = posedAt(first.s, images, r, "k", 0.2).world;
      expect(after[2]).toBeCloseTo(first.before[2]! + 12, 3);
      expect(after[3]).toBeCloseTo(first.before[3]! - 7, 3);
      for (let v = 0; v < after.length / 2; v++) if (v !== 1) {
        expect(after[v * 2], `vertex ${v}`).toBeCloseTo(first.before[v * 2]!, 3);
        expect(after[v * 2 + 1], `vertex ${v}`).toBeCloseTo(first.before[v * 2 + 1]!, 3);
      }
      // A second drag at the same time keys over the first: both moves kept.
      const second = drag(first.s, images, r, "k", 0.2, 0, -5, 4);
      const both = posedAt(second.s, images, r, "k", 0.2).world;
      expect(both[0]).toBeCloseTo(first.before[0]! - 5, 3);
      expect(both[2]).toBeCloseTo(first.before[2]! + 12, 3);
      const key = keysAt(second.s.animations!.at(-1)!, { section: "attachments", skin: r.skin, slot: r.slot, attachment: r.key, timeline: "deform" })!;
      expect(key.length).toBe(1);
      sound(second.s, atlas);
    });
  }
  it("a deform keyed back to no offset at all has no vertices", () => {
    const { doc, images } = sample("spineboy-pro", "spineboy-pro.json");
    const slot = doc.slots!.find((x) => x.attachment && doc.skins![0]!.attachments!.find((ss) => ss.slot === x.name)?.entries.find((e) => e.key === x.attachment && (e.attachment.type ?? "region") === "region"))!;
    const r = { skin: "default", slot: slot.name, key: slot.attachment! };
    let s = addAnimation("k")(regionToMesh(r)(doc));
    const n = findAttachment(s, r)!.vertices!.length;
    s = keyDeform("k", r, 0, [0, 0, 3, 0, ...new Array(n - 4).fill(0)])(s);
    expect(keysAt(s.animations!.at(-1)!, { section: "attachments", skin: "default", slot: r.slot, attachment: r.key, timeline: "deform" })![0]).toMatchObject({ offset: 2, vertices: [3] });
    s = keyDeform("k", r, 0, new Array(n).fill(0))(s);
    const k = keysAt(s.animations!.at(-1)!, { section: "attachments", skin: "default", slot: r.slot, attachment: r.key, timeline: "deform" })![0]!;
    expect(k).not.toHaveProperty("vertices");
    expect(k).not.toHaveProperty("offset");
    expect(() => keyDeform("k", { ...r, key: "nope" }, 0, [])(s)).toThrow(/not a mesh/);
    void images;
  });
});
