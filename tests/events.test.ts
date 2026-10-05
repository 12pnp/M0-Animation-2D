import { describe, expect, it } from "vitest";
import {
  deleteEventKeys, eventDefsFromBoneBurst, eventFrames, eventValues, moveEventKeys, renamedEvent, uniqueEventName,
  withEventDefValues, withEventKey, withEventKeyValues, withoutEvent,
} from "@/core/doc/events";
import { migrate, validateProject } from "@/core/doc/schema";
import { exportBoneBurst, boneburstJson } from "@/core/boneburst/exportBoneBurst";
import { importBoneBurst } from "@/core/boneburst/importBoneBurst";
import { DOC_VERSION, type Animation, type EventDef, type EventKey, type SymbolItem } from "@/core/doc/types";
import type { AnimId } from "@/core/doc/ids";
import { loadStickman } from "./fixtures/stickman";
import { SoundStore, soundPath } from "@/app/SoundStore";
import { deserializeProject, serializeProject } from "@/io/project/ProjectFile";
import { fakeAssets } from "./fixtures/realProject";

const step: EventDef = { name: "step", int: 2, string: "l" };
const hit: EventDef = { name: "hit", audio: "hit.ogg", volume: 0.5 };

describe("event values", () => {
  it.each([
    ["the event's own", step, undefined, { int: 2, float: 0, string: "l", audio: null, volume: 1, balance: 0 }],
    ["a key's overrides", step, { frame: 0, name: "step", int: 7, float: 1.5 }, { int: 7, float: 1.5, string: "l", audio: null, volume: 1, balance: 0 }],
    ["a sound's volume, the key's balance", hit, { frame: 0, name: "hit", balance: -1 }, { int: 0, float: 0, string: "", audio: "hit.ogg", volume: 0.5, balance: -1 }],
  ] as const)("%s", (_, def, key, want) => {
    expect(eventValues(def, key as EventKey | undefined)).toEqual(want);
  });

  it("Spine's defaults are left off an event", () => {
    expect(withEventDefValues({ name: "e" }, { int: 0, float: 0, string: "", volume: 1, balance: 0 })).toEqual({ name: "e" });
    expect(withEventDefValues(hit, { audio: "" })).toEqual({ name: "hit", volume: 0.5 });
  });
});

describe("editing event keys", () => {
  const keys: EventKey[] = [
    { frame: 2, name: "step" },
    { frame: 5, name: "hit" },
    { frame: 5, name: "step", int: 1 },
    { frame: 9, name: "step" },
  ];
  it("a new key fires after the keys already on its frame", () => {
    expect(withEventKey(keys, 5, "plain").map((k) => `${k.frame}:${k.name}`)).toEqual(["2:step", "5:hit", "5:step", "5:plain", "9:step"]);
  });
  it("moving a frame's keys keeps their order and lands after what is there; never before 0", () => {
    expect(moveEventKeys(keys, [5], 4).map((k) => `${k.frame}:${k.name}`)).toEqual(["2:step", "9:step", "9:hit", "9:step"]);
    expect(moveEventKeys(keys, [2, 5], -10).map((k) => k.frame)).toEqual([0, 0, 0, 9]);
  });
  it("deleting a frame's keys, and the frames that have keys", () => {
    expect(deleteEventKeys(keys, [5]).map((k) => k.frame)).toEqual([2, 9]);
    expect(eventFrames(keys)).toEqual([2, 5, 9]);
  });
  it("one key's values at a frame: set, and cleared back to the event's", () => {
    const set = withEventKeyValues(keys, 5, 1, { float: 2, int: undefined });
    expect(set[2]).toEqual({ frame: 5, name: "step", float: 2 });
    expect(set[1]).toBe(keys[1]);
  });
});

describe("the event list", () => {
  const anims = [
    { id: "a1", events: [{ frame: 1, name: "step" }, { frame: 2, name: "hit" }] },
    { id: "a2", events: [{ frame: 0, name: "hit" }] },
  ] as unknown as Animation[];
  it("a unique name", () => {
    expect(uniqueEventName([step, { name: "step 2" }], "step")).toBe("step 3");
    expect(uniqueEventName([], "  ")).toBe("event");
  });
  it("a rename takes the keys along, and refuses a taken or empty name", () => {
    const out = renamedEvent([step, hit], anims, "step", "foot")!;
    expect(out.defs.map((d) => d.name)).toEqual(["foot", "hit"]);
    expect([...out.keys.keys()]).toEqual(["a1"]);
    expect(out.keys.get("a1" as AnimId)!.map((k) => k.name)).toEqual(["foot", "hit"]);
    expect(renamedEvent([step, hit], anims, "step", "hit")).toBeNull();
    expect(renamedEvent([step, hit], anims, "step", " ")).toBeNull();
  });
  it("a delete takes its keys along", () => {
    const out = withoutEvent([step, hit], anims, "hit");
    expect(out.defs).toEqual([step]);
    expect(out.keys.get("a1" as AnimId)).toEqual([{ frame: 1, name: "step" }]);
    expect(out.keys.get("a2" as AnimId)).toEqual([]);
  });
  it("Spine's skeleton events as the list", () => {
    expect(eventDefsFromBoneBurst({ a: { int: 3.7, string: "x" }, b: { audio: "s.ogg", volume: 0.2, balance: 0.1 }, c: { volume: 0.3 } }))
      .toEqual([{ name: "a", int: 3, string: "x" }, { name: "b", audio: "s.ogg", volume: 0.2, balance: 0.1 }, { name: "c" }]);
  });
});

describe("events in files", () => {
  it("a file keeps known keys in frame order, values of the right type, unique non-empty names", async () => {
    const { project, rig } = await loadStickman();
    rig.events = [{ name: " step " }, { name: "step" }, { name: "" }, { name: "hit", int: "3", volume: 5 }] as never;
    rig.animations[0]!.events = [
      { frame: 9, name: "hit" }, { frame: 2, name: "step", int: 1.9 }, { frame: 2, name: "gone" }, { frame: 2, name: "hit" },
    ] as never;
    const out = validateProject(migrate(JSON.parse(JSON.stringify({ ...project, version: 18 })))).project;
    const sym = out.items[out.rootSymbolId] as SymbolItem;
    expect(out.version).toBe(DOC_VERSION);
    expect(sym.events).toEqual([{ name: "step" }, { name: "hit" }]);
    expect(sym.animations[0]!.events).toEqual([{ frame: 2, name: "step", int: 1 }, { frame: 2, name: "hit" }, { frame: 9, name: "hit" }]);
  });

  it("an opened file's carried events move to the list (18 -> 19)", async () => {
    const { project, rig } = await loadStickman();
    rig.spine = { header: {}, constraints: [], skins: [], events: { foot: { int: 1 } } } as never;
    const out = validateProject(migrate(JSON.parse(JSON.stringify({ ...project, version: 18 })))).project;
    const sym = out.items[out.rootSymbolId] as SymbolItem;
    expect(sym.events).toEqual([{ name: "foot", int: 1 }]);
    expect(sym.spine).not.toHaveProperty("events");
  });

  it("export then open gives the events and keys back", async () => {
    const { project, rig } = await loadStickman();
    rig.events = [step, hit, { name: "plain", float: 0.25 }];
    const keys: EventKey[] = [
      { frame: 0, name: "plain" },
      { frame: 4, name: "step", int: 9 },
      { frame: 4, name: "hit", volume: 0.25 },
      { frame: 11, name: "hit", balance: 0.5, string: "x" },
    ];
    rig.animations[0]!.events = keys;
    const file = JSON.parse(boneburstJson(exportBoneBurst(project).skeleton));
    const opened = importBoneBurst(file, "stickman", new Map()).project;
    const sym = opened.items[opened.rootSymbolId] as SymbolItem;
    expect(sym.events).toEqual(rig.events);
    const back = sym.animations.find((a) => a.name === rig.animations[0]!.name)!;
    expect(back.events).toEqual(keys);
    expect(back.spine?.events).toBeUndefined();
  });

  it("a key between frames keeps the file's timeline carried", async () => {
    const { project, rig } = await loadStickman();
    rig.events = [step];
    rig.animations[0]!.events = [{ frame: 1, name: "step" }];
    const file = JSON.parse(boneburstJson(exportBoneBurst(project).skeleton));
    const name = rig.animations[0]!.name;
    file.animations[name].events[0].time = 0.1234567 / project.frameRate;
    const sym = importBoneBurst(file, "stickman", new Map()).project;
    const back = (sym.items[sym.rootSymbolId] as SymbolItem).animations.find((a) => a.name === name)!;
    expect(back.events).toBeUndefined();
    expect(back.spine?.events).toHaveLength(1);
  });
});

describe("a sound's path", () => {
  it.each([
    ["a plain name", "step.ogg", "step.ogg"],
    ["backslashes and a leading slash", "\\sfx\\hit.wav", "sfx/hit.wav"],
    ["no way out of the audio folder", "../../etc/x.ogg", "etc/x.ogg"],
    ["nothing left", "./..", "sound"],
  ])("%s", (_, name, want) => {
    expect(soundPath(name)).toBe(want);
  });
});

describe("sounds in the project file", () => {
  it("the sounds events name are saved and loaded under their paths; others are not", async () => {
    const { project, rig } = await loadStickman();
    rig.events = [{ name: "step", audio: "sfx/step.ogg" }, { name: "quiet" }];
    const sounds = new SoundStore();
    sounds.add(new Blob([new Uint8Array([1, 2, 3])]), "sfx/step.ogg");
    sounds.add(new Blob([new Uint8Array([9])]), "unused.wav");
    const blob = await serializeProject(project, fakeAssets(), sounds);
    const back = new SoundStore();
    back.add(new Blob([new Uint8Array([7])]), "stale.ogg");
    await deserializeProject(await blob.arrayBuffer(), fakeAssets(), () => {}, back);
    expect(back.paths()).toEqual(["sfx/step.ogg"]);
    expect([...new Uint8Array(await back.get("sfx/step.ogg")!.arrayBuffer())]).toEqual([1, 2, 3]);
  });
});
