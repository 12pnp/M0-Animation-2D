import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findAttachment } from "@/edit/attachments";
import { addSkin, deleteSkin, duplicateSkin, moveAttachment, renameSkin, setSkinMember } from "@/edit/skins";
import { readSkeleton } from "@/io/skeletonRead";
import { writeSkeleton } from "@/io/skeletonWrite";
import { profileIssues } from "@/model/profile";
import type { Skeleton } from "@/model/skeleton";
import { compare, TOLERANCE } from "./fixtures/oracle";
import { SAMPLES } from "./fixtures/samples";

const sample = (dir: string, file: string) => ({
  doc: readSkeleton(readFileSync(join(SAMPLES, dir, file), "utf8")).skeleton,
  atlas: readdirSync(join(SAMPLES, dir)).filter((f) => f.endsWith(".atlas.txt")).map((f) => readFileSync(join(SAMPLES, dir, f), "utf8").trim()).join("\n\n"),
});
const goblins = () => sample("Goblins", "goblins.json");
const mix = () => sample("mix-and-match", "mix-and-match-pro.json");
const hero = () => sample("Hero", "hero-pro.json");

/** The profile holds, the file round-trips, and both runtimes pose every skin alike. */
function sound(s: Skeleton, atlas: string): void {
  expect(profileIssues(s)).toEqual([]);
  const text = writeSkeleton(s);
  expect(writeSkeleton(readSkeleton(text).skeleton)).toBe(text);
  const { worst } = compare("edited", text, atlas, [0, 0.5]);
  expect(worst.value, worst.where).toBeLessThanOrEqual(TOLERANCE);
}

/** A skin's deform and sequence timelines, as [slot, attachment] pairs over all animations. */
const timelinesOf = (s: Skeleton, skin: string) =>
  (s.animations ?? []).flatMap((a) => (a.attachments ?? []).filter((t) => t.skin === skin).flatMap((t) => t.slots.flatMap((sl) => sl.attachments.map((g) => `${a.name}/${sl.slot}/${g.name}`)))).sort();

describe("skins", () => {
  it("adds a skin, refusing an empty, taken or default name", () => {
    const { doc } = goblins();
    expect(addSkin("orc")(doc).skins!.at(-1)!.name).toBe("orc");
    expect(() => addSkin("goblin")(doc)).toThrow(/already/);
    expect(() => addSkin("default")(doc)).toThrow(/default skin's name/);
    expect(() => addSkin(" ")(doc)).toThrow(/needs a name/);
  });
  it("renames a skin with its deform timelines and the linked meshes that name it", () => {
    const { doc, atlas } = goblins();
    const skin = doc.animations!.flatMap((a) => a.attachments ?? []).map((t) => t.skin).find((n) => n !== "default")!;
    const before = timelinesOf(doc, skin);
    expect(before.length).toBeGreaterThan(0);
    const s = renameSkin(skin, "renamed")(doc);
    expect(timelinesOf(s, "renamed")).toEqual(before);
    expect(timelinesOf(s, skin)).toEqual([]);
    expect(JSON.stringify(s.skins!.flatMap((k) => k.attachments ?? []).flatMap((ss) => ss.entries).map((e) => e.attachment.skin))).not.toContain(`"${skin}"`);
    sound(s, atlas);
    expect(() => renameSkin("default", "x")(doc)).toThrow(/keeps its name/);
  });
  it("duplicates a skin with its lists and timelines; the copy poses as the original", () => {
    const { doc, atlas } = goblins();
    const skin = doc.skins!.find((k) => k.name !== "default")!.name;
    const s = duplicateSkin(skin, "copy")(doc);
    expect(timelinesOf(s, "copy")).toEqual(timelinesOf(s, skin));
    expect(s.skins!.at(-1)!.attachments!.length).toBe(doc.skins!.find((k) => k.name === skin)!.attachments!.length);
    sound(s, atlas);
  });
  it("duplicates a mix-and-match outfit: skin-required bones and constraints come along", () => {
    const { doc, atlas } = mix();
    const skin = doc.skins!.find((k) => k.bones?.length && k.ik?.length)?.name ?? doc.skins!.find((k) => k.bones?.length)!.name;
    const s = duplicateSkin(skin, "outfit copy")(doc);
    const a = s.skins!.find((k) => k.name === skin)!, b = s.skins!.find((k) => k.name === "outfit copy")!;
    expect([b.bones, b.ik, b.transform, b.path, b.physics]).toEqual([a.bones, a.ik, a.transform, a.path, a.physics]);
    sound(s, atlas);
  });
  it("deletes a skin with its timelines; not the default, nor one a linked mesh elsewhere needs", () => {
    const { doc, atlas } = goblins();
    // goblingirl's linked meshes take their sources from goblin: goblin stays, goblingirl can go.
    expect(() => deleteSkin("goblin")(doc)).toThrow(/linked mesh goblingirl\/.* takes its source from it/);
    const s = deleteSkin("goblingirl")(doc);
    expect(s.skins!.map((k) => k.name)).toEqual(["default", "goblin"]);
    expect(timelinesOf(s, "goblingirl")).toEqual([]);
    sound(s, atlas);
    expect(() => deleteSkin("default")(doc)).toThrow(/default skin cannot/);
  });
  it("turns skin-required bones on and off, refusing a stranger", () => {
    const { doc, atlas } = hero();
    const skin = doc.skins!.find((k) => k.bones?.length)!;
    const bone = skin.bones![0]!;
    const off = setSkinMember(skin.name, "bones", bone, false)(doc);
    expect(off.skins!.find((k) => k.name === skin.name)!.bones ?? []).not.toContain(bone);
    expect(setSkinMember(skin.name, "bones", bone, true)(off).skins!.find((k) => k.name === skin.name)!.bones).toContain(bone);
    expect(setSkinMember(skin.name, "bones", bone, true)(doc)).toBe(doc);
    expect(() => setSkinMember(skin.name, "ik", "nope", true)(doc)).toThrow(/no ik constraint/);
    sound(off, atlas);
  });
  it("moves an attachment to another skin with its timelines, and the linked meshes that use it follow", () => {
    const { doc, atlas } = goblins();
    // An attachment some linked mesh takes as its source, with a deform timeline if there is one.
    const all = doc.skins!.flatMap((k) => (k.attachments ?? []).flatMap((ss) => ss.entries.map((e) => ({ skin: k.name, slot: ss.slot, key: e.key, a: e.attachment }))));
    const link = all.find((x) => x.a.source !== undefined)!;
    const r = { skin: link.a.skin ?? "default", slot: link.a.slot ?? link.slot, key: link.a.source! };
    const to = doc.skins!.find((k) => k.name !== r.skin && !findAttachment(doc, { ...r, skin: k.name }))!.name;
    const s = moveAttachment(r, to)(doc);
    expect(findAttachment(s, r)).toBeUndefined();
    expect(findAttachment(s, { ...r, skin: to })).toBeDefined();
    const moved = s.skins!.flatMap((k) => (k.attachments ?? []).flatMap((ss) => ss.entries)).find((e) => e.key === link.key && e.attachment.source === r.key)!;
    expect(moved.attachment.skin ?? "default").toBe(to);
    expect(profileIssues(s)).toEqual([]);
    expect(() => moveAttachment(r, r.skin)(doc)).not.toThrow();
    expect(() => moveAttachment({ ...r, key: "nope" }, to)(doc)).toThrow(/no attachment/);
    sound(s, atlas);
  });
});
