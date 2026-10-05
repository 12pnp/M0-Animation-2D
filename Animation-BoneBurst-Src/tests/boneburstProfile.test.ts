import { describe, expect, it } from "vitest";
import { profileIssues } from "@/core/boneburst/profile";
import { sampleRigs } from "./fixtures/spineSamples";

/**
 * The BoneBurst profile of Spine 4.3 JSON (`Packages/com.module.ta-creator-boneburst/
 * Doc/Format/BoneBurst-Profile.md`): stock exports keep to it, and each way a file can
 * break it is caught. Every export spineParity and spineImport make is held to it
 * with `written` too.
 */

type Json = Record<string, unknown>;

const mesh = { type: "mesh", uvs: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2], vertices: [0, 0, 10, 0, 10, 10] };

/** A small valid file; `edit` breaks one thing in it. */
function file(edit: (f: Json) => void = () => {}): Json {
  const f: Json = {
    skeleton: { spine: "4.3.0", hash: "h", fps: 30 },
    bones: [{ name: "root" }, { name: "arm", parent: "root" }],
    slots: [{ name: "a", bone: "root", attachment: "m" }, { name: "b", bone: "arm" }],
    constraints: [{ type: "transform", name: "t", source: "root", bones: ["arm"], properties: { rotate: { to: { rotate: {} } } } }],
    skins: [{ name: "default", attachments: { a: { m: mesh }, b: { l: { type: "linkedmesh", source: "m", slot: "a" } } } }],
    events: { step: {} },
    animations: {
      walk: {
        bones: { arm: { rotate: [{ value: 10 }] } },
        slots: { a: { rgba: [{ color: "ffffffff" }] } },
        transform: { t: [{ mixRotate: 1 }] },
        attachments: { default: { a: { m: { deform: [{ time: 0 }] } } } },
        events: [{ name: "step" }],
      },
    },
  };
  edit(f);
  return f;
}

const anim = (f: Json) => (f.animations as Record<string, Json>).walk!;
const skin = (f: Json) => (f.skins as Json[])[0]!.attachments as Record<string, Record<string, Json>>;

describe("the BoneBurst profile", () => {
  it("a valid file, a linked mesh whose source is in another slot included, has no issues", () => {
    expect(profileIssues(file(), { written: true })).toEqual([]);
  });

  it("spine-unity's samples keep to it as files to read", () => {
    const samples = sampleRigs();
    for (const r of samples) expect(profileIssues(JSON.parse(r.json)), r.name).toEqual([]);
  });

  it.each<[string, (f: Json) => void, string]>([
    ["a version other than 4.3", (f) => { (f.skeleton as Json).spine = "4.2.43"; }, "Spine 4.3 only"],
    ["no header", (f) => { delete f.skeleton; }, 'no "skeleton" header'],
    ["a parent named after its child", (f) => { (f.bones as Json[]).reverse(); }, "parent bone not found"],
    ["a slot on a missing bone", (f) => { (f.slots as Json[])[1]!.bone = "leg"; }, "slot bone not found"],
    ["an unknown constraint type", (f) => { (f.constraints as Json[])[0]!.type = "spring"; }, "unknown constraint type"],
    ["an unknown transform property", (f) => { (f.constraints as Json[])[0]!.properties = { rotation: { to: { rotate: {} } } }; }, "unknown transform property"],
    ["an unknown attachment type", (f) => { skin(f).a!.m = { type: "sprite" }; }, "unknown attachment type"],
    ["a mesh without triangles", (f) => { skin(f).a!.m = { ...mesh, triangles: undefined }; }, "mesh has no triangles"],
    ["a linked mesh whose source is not in its slot", (f) => { delete (skin(f).b!.l as Json).slot; }, "source mesh not found"],
    ["a linkedmesh with no source, read as a plain mesh", (f) => { skin(f).b!.l = { type: "linkedmesh" }; }, "mesh has no uvs"],
    ["a bone timeline with a capital letter (the readers skip it)", (f) => { anim(f).bones = { arm: { translateX: [{}] } }; }, 'unknown timeline "translateX"'],
    ["a slot timeline the readers do not know", (f) => { anim(f).slots = { a: { tint: [{}] } }; }, 'unknown timeline "tint"'],
    ["keys for a missing constraint", (f) => { anim(f).transform = { gone: [{}] }; }, "transform constraint not found"],
    ["deform keys for a missing attachment", (f) => { anim(f).attachments = { default: { a: { x: { deform: [{}] } } } }; }, "timeline attachment not found"],
    ["an event that is not declared", (f) => { anim(f).events = [{ name: "jump" }]; }, "event not found"],
  ])("catches %s", (_name, edit, expected) => {
    const issues = profileIssues(file(edit));
    expect(issues.join("\n")).toContain(expected);
  });

  it("a file the editor writes must carry the hash; one it reads need not", () => {
    const noHash = file((f) => { delete (f.skeleton as Json).hash; });
    expect(profileIssues(noHash)).toEqual([]);
    expect(profileIssues(noHash, { written: true })).toEqual(['header has no "hash"']);
  });
});
