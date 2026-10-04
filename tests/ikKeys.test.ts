import { beforeAll, describe, expect, it } from "vitest";
import {
  deleteIkKeys, ikPoseAt, ikTweenOf, moveIkKeys, SMOOTH_CURVE, withIkKey, withIkKeys, withIkTween,
} from "@/core/doc/ikKeys";
import { focusRows } from "@/core/doc/layerTree";
import { migrate, validateProject } from "@/core/doc/schema";
import { exportSpine, spineJson } from "@/core/spine/exportSpine";
import { importSpine } from "@/core/spine/importSpine";
import { applyTween } from "@/core/math/easing";
import { DOC_VERSION, type Animation, type IkConstraint, type IkKey, type SymbolItem } from "@/core/doc/types";
import type { IkId, NodeId } from "@/core/doc/ids";
import { loadStickman, type Stickman } from "./fixtures/stickman";

const k: IkConstraint = {
  id: "k" as IkId, name: "leg", boneId: "b" as NodeId, targetId: "t" as NodeId, chain: 1, bendPositive: false, weight: 0.8,
};
const anim = (keys: IkKey[]): Animation =>
  ({ id: "a", name: "a", duration: 30, playTimes: 0, tracks: {}, ik: { [k.id]: keys } }) as unknown as Animation;

describe("ikPoseAt", () => {
  const keys: IkKey[] = [
    { frame: 5, mix: 1, bendPositive: false },
    { frame: 10, mix: 0, bendPositive: true, tween: { kind: "none" } },
    { frame: 20, mix: 1, bendPositive: false, tween: { kind: "curve", curve: SMOOTH_CURVE } },
    { frame: 26, mix: 0.5, bendPositive: true },
  ];
  it.each([
    ["before the first key: the constraint's own", 2, 0.8, false],
    ["on a key", 5, 1, false],
    ["linear between keys, the bend stepped", 7.5, 0.5, false],
    ["a stepped key holds", 15, 0, true],
    ["on the key after it", 20, 1, false],
    ["past the last key", 29, 0.5, true],
  ] as const)("%s", (_, frame, mix, bendPositive) => {
    const p = ikPoseAt(k, anim(keys), frame);
    expect(p.mix).toBeCloseTo(mix, 9);
    expect(p.bendPositive).toBe(bendPositive);
  });

  it("a smooth key eases as the runtime samples it", () => {
    expect(ikPoseAt(k, anim(keys), 23).mix).toBeCloseTo(1 - 0.5 * applyTween({ kind: "curve", curve: SMOOTH_CURVE }, 0.5, 6), 9);
  });

  it("no keys, or no animation: the constraint's own", () => {
    expect(ikPoseAt(k, null, 3)).toEqual({ mix: 0.8, bendPositive: false });
    expect(ikPoseAt(k, anim([]), 3)).toEqual({ mix: 0.8, bendPositive: false });
  });
});

describe("editing IK keys", () => {
  const keys: IkKey[] = [
    { frame: 0, mix: 1, bendPositive: false, tween: { kind: "none" } },
    { frame: 4, mix: 0.5, bendPositive: true },
    { frame: 8, mix: 0, bendPositive: false },
  ];
  it("keying a frame replaces its values and keeps its tween; the mix is clamped", () => {
    expect(withIkKey(keys, 0, { mix: 2, bendPositive: true })[0]).toEqual({ frame: 0, mix: 1, bendPositive: true, tween: { kind: "none" } });
    expect(withIkKey(keys, 6, { mix: 0.3, bendPositive: false }).map((x) => x.frame)).toEqual([0, 4, 6, 8]);
  });
  it("moving keys replaces the ones they land on and stops at frame 0", () => {
    expect(moveIkKeys(keys, [4], 4).map((x) => [x.frame, x.mix])).toEqual([[0, 1], [8, 0.5]]);
    expect(moveIkKeys(keys, [4, 8], -10).map((x) => [x.frame, x.mix])).toEqual([[0, 0]]);
  });
  it("deleting, tweens, and the animation's map", () => {
    expect(deleteIkKeys(keys, [0, 8]).map((x) => x.frame)).toEqual([4]);
    const smooth = withIkTween(keys, [0, 4], "smooth");
    expect(smooth.map(ikTweenOf)).toEqual(["smooth", "smooth", "linear"]);
    expect(withIkTween(smooth, [0], "linear")[0]).not.toHaveProperty("tween");
    expect(withIkKeys({ [k.id]: keys }, k.id, [])).toBeUndefined();
  });
});

describe("the IK rows", () => {
  let s: Stickman;
  beforeAll(async () => { s = await loadStickman(); });

  it("unfocused, a keyed constraint's row sits under its target", () => {
    const sym = s.rig;
    const ik = sym.ik[0]!;
    const a = { ...sym.animations[0]!, ik: { [ik.id]: [{ frame: 0, mix: 1, bendPositive: false }] } };
    const rows = focusRows(sym, [], true, a);
    const at = rows.findIndex((r) => r.ik === ik.id);
    expect(rows[at - 1]!.node.id).toBe(ik.targetId);
    expect(rows.filter((r) => r.ik)).toHaveLength(1);
    expect(focusRows(sym, [], true, sym.animations[0]).some((r) => r.ik)).toBe(false);
  });

  it("focused on a chain bone, its constraint's row follows its property rows", () => {
    const sym = s.rig;
    const ik = sym.ik.find((c) => c.boneId === s.node("leg_near_shin"))!;
    const rows = focusRows(sym, [s.node("leg_near_shin")], true, sym.animations[0]);
    expect(rows.map((r) => r.prop ?? (r.ik ? "ik" : r.node.name))).toEqual(["leg_near_shin", "rotate", "x", "y", "scale", "shear", "ik"]);
    expect(rows[6]!.ik).toBe(ik.id);
  });
});

describe("IK keys in files", () => {
  it("a file keeps keys of known constraints only, one per frame, sorted, tweens it can write", async () => {
    const { project, rig } = await loadStickman();
    const id = rig.ik[0]!.id;
    rig.animations[0]!.ik = {
      [id]: [
        { frame: 9, mix: 3, bendPositive: true, tween: { kind: "ease", value: 1 } },
        { frame: 2, mix: 0.5, bendPositive: false, tween: { kind: "none" } },
        { frame: 9, mix: 0.25, bendPositive: false },
      ],
      gone: [{ frame: 0, mix: 1, bendPositive: false }],
    } as never;
    const raw = JSON.parse(JSON.stringify({ ...project, version: 16 }));
    const out = validateProject(migrate(raw)).project;
    expect(out.version).toBe(DOC_VERSION);
    const sym = out.items[out.rootSymbolId] as SymbolItem;
    expect(sym.animations[0]!.ik).toEqual({
      [id]: [{ frame: 2, mix: 0.5, bendPositive: false, tween: { kind: "none" } }, { frame: 9, mix: 0.25, bendPositive: false }],
    });
  });

  it("export then open gives the same keys back", async () => {
    const { project, rig } = await loadStickman();
    const [a, b] = rig.ik;
    const keys: Record<string, IkKey[]> = {
      [a!.id]: [
        { frame: 0, mix: 1, bendPositive: a!.bendPositive, tween: { kind: "curve", curve: SMOOTH_CURVE } },
        { frame: 6, mix: 0.2, bendPositive: !a!.bendPositive, tween: { kind: "none" } },
        { frame: 12, mix: 0.7, bendPositive: a!.bendPositive },
      ],
      [b!.id]: [{ frame: 3, mix: 0, bendPositive: !b!.bendPositive }],
    };
    rig.animations[0]!.ik = keys;
    const file = JSON.parse(spineJson(exportSpine(project).skeleton));
    expect(Object.keys(file.animations[rig.animations[0]!.name].ik)).toHaveLength(2);
    const opened = importSpine(file, "stickman", new Map()).project;
    const sym = opened.items[opened.rootSymbolId] as SymbolItem;
    const byName = (s: SymbolItem, id: string) => s.ik.find((c) => c.id === id)!.name;
    const back = sym.animations.find((x) => x.name === rig.animations[0]!.name)!;
    for (const [id, list] of Object.entries(keys)) {
      const got = back.ik?.[sym.ik.find((c) => c.name === byName(rig, id))!.id];
      expect(got?.map((x) => ({ ...x, mix: Math.round(x.mix * 1e6) / 1e6, ...(x.tween?.kind === "curve" ? { tween: { kind: "curve", curve: x.tween.curve.map((v) => Math.round(v * 1e4) / 1e4) } } : {}) }))).toEqual(list);
    }
    expect(back.spine?.ik).toBeUndefined();
  });
});
