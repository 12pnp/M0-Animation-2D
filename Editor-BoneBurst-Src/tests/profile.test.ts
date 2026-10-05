import { describe, expect, it } from "vitest";
import { readSkeleton } from "@/io/skeletonRead";
import { profileIssues } from "@/model/profile";
import { sampleFiles } from "./fixtures/samples";

/** A small file every rule passes; each case below breaks one thing in it. */
const GOOD = {
  skeleton: { hash: "h", spine: "4.3.0" },
  bones: [{ name: "root" }, { name: "hip", parent: "root" }],
  slots: [{ name: "body", bone: "hip", attachment: "body" }, { name: "clip", bone: "root" }],
  constraints: [
    { name: "reach", type: "ik", bones: ["hip"], target: "root" },
    { name: "follow", type: "transform", bones: ["hip"], source: "root", properties: { rotate: { to: { rotate: {} } } } },
    { name: "slide", type: "slider", animation: "walk" },
  ],
  skins: [{
    name: "default",
    attachments: {
      body: {
        body: { type: "mesh", uvs: [0, 0, 1, 0, 1, 1], vertices: [0, 0, 1, 0, 1, 1], triangles: [0, 1, 2] },
        copy: { type: "linkedmesh", source: "body" },
      },
      clip: { mask: { type: "clipping", end: "body", vertexCount: 3, vertices: [0, 0, 1, 0, 1, 1] } },
    },
  }],
  events: { step: {} },
  animations: {
    walk: {
      bones: { hip: { rotate: [{ value: 10 }] } },
      slots: { body: { rgba: [{ color: "ffffffff" }] } },
      ik: { reach: [{ mix: 0.5 }] },
      attachments: { default: { body: { body: { deform: [{}] } } } },
      events: [{ name: "step" }],
    },
  },
};

type Patch = (f: typeof GOOD & Record<string, unknown>) => void;
const issuesOf = (patch: Patch, written = false) => {
  const f = structuredClone(GOOD) as typeof GOOD & Record<string, unknown>;
  patch(f);
  return profileIssues(readSkeleton(JSON.stringify(f)).skeleton, { written }).map((i) => i.message);
};

describe("profileIssues", () => {
  it("passes the good file, read and written", () => {
    expect(issuesOf(() => {})).toEqual([]);
    expect(issuesOf(() => {}, true)).toEqual([]);
  });
  it.each<[string, Patch, RegExp]>([
    ["another Spine version", (f) => { f.skeleton.spine = "4.2.43"; }, /4\.3 only/],
    ["a parent after its child", (f) => { f.bones.reverse(); }, /not an earlier bone/],
    ["a slot on a missing bone", (f) => { f.slots[0]!.bone = "leg"; }, /bone "leg" is not a bone/],
    ["an unknown transform property", (f) => { (f.constraints[1] as { properties: object }).properties = { spin: { to: { rotate: {} } } }; }, /unknown property "spin"/],
    ["an unknown attachment type", (f) => { (f.skins[0]!.attachments.body.body as { type: string }).type = "sprite"; }, /unknown attachment type/],
    ["a linked mesh with no source", (f) => { f.skins[0]!.attachments.body.copy.source = "nope"; }, /source "nope" not found/],
    ["a mesh without triangles", (f) => { delete (f.skins[0]!.attachments.body.body as { triangles?: unknown }).triangles; }, /mesh without triangles/],
    ["a clipping ending at no slot", (f) => { f.skins[0]!.attachments.clip.mask.end = "gone"; }, /clipping end "gone"/],
    ["a misspelt timeline", (f) => { (f.animations.walk.bones.hip as Record<string, unknown>)["Rotate"] = [{}]; }, /unknown timeline "Rotate"/],
    ["a keyed bone that does not exist", (f) => { (f.animations.walk.bones as Record<string, unknown>)["arm"] = {}; }, /keyed "arm" is not a bone/],
    ["IK keys on no IK constraint", (f) => { (f.animations.walk.ik as Record<string, unknown>)["follow"] = []; }, /"follow" is not an IK constraint/],
    ["a deform on a missing attachment", (f) => { (f.animations.walk.attachments.default.body as Record<string, unknown>)["ghost"] = { deform: [] }; }, /attachment not found/],
    ["an event key naming no event", (f) => { f.animations.walk.events[0]!.name = "jump"; }, /event "jump" does not exist/],
    ["a slider on a missing animation", (f) => { (f.constraints[2] as { animation: string }).animation = "run"; }, /animation "run" does not exist/],
  ])("catches %s", (_what, patch, want) => {
    expect(issuesOf(patch).some((m) => want.test(m))).toBe(true);
  });
  it("asks a written file for a hash and 4.3.0", () => {
    expect(issuesOf((f) => { delete (f.skeleton as { hash?: string }).hash; f.skeleton.spine = "4.3.39"; }, true))
      .toEqual(["no hash (spine-csharp requires it)", "written as 4.3.39; a written file says 4.3.0"]);
  });
});

describe("every sample passes the profile as a file to read", () => {
  it.each(sampleFiles(".json").map((f) => [f.name, f.text]))("%s", (_n, text) => {
    expect(profileIssues(readSkeleton(text).skeleton)).toEqual([]);
  });
});
