import { beforeEach, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { createAnimation, createProject } from "@/core/doc/defaults";
import { mergePrefs } from "@/core/prefs/prefs";
import type { SymbolItem } from "@/core/doc/types";
import { PathCache } from "@/view/viewport/pathCache";

beforeEach(() => reseed());

function scene() {
  const project = createProject("P");
  const sym = project.items[project.rootSymbolId] as SymbolItem;
  const anim = sym.animations[0]!;
  return { project, sym, anim };
}

/** A clock that only moves when told to. */
function clock() {
  let t = 0;
  return { now: () => t, tick: (ms: number) => { t += ms; } };
}

describe("PathCache", () => {
  it("poses a frame once per revision", () => {
    const { project, sym, anim } = scene();
    const cache = new PathCache();
    const a = cache.sampler(project, sym, anim, 1)(3);
    expect(cache.sampler(project, sym, anim, 1)(3)).toBe(a);
    expect(cache.sampler(project, sym, anim, 2)(3)).not.toBe(a);
  });

  it("past its budget, hands out the previous revision's pose and asks for another draw", () => {
    const { project, sym, anim } = scene();
    const c = clock();
    const cache = new PathCache(6);
    const first = cache.sampler(project, sym, anim, 1, c.now);
    const old = [0, 1, 2].map((f) => first(f));
    expect(cache.pending).toBe(false);

    const second = cache.sampler(project, sym, anim, 2, c.now);
    const redone = second(0);
    expect(redone).not.toBe(old[0]);
    c.tick(10);
    expect(second(1)).toBe(old[1]);
    expect(cache.pending).toBe(true);

    // The next draw finishes what was left, and keeps what was redone.
    const third = cache.sampler(project, sym, anim, 2, c.now);
    expect(third(0)).toBe(redone);
    expect(third(1)).not.toBe(old[1]);
    expect(cache.pending).toBe(false);
  });

  it("starts over for another animation", () => {
    const { project, sym, anim } = scene();
    const other = createAnimation("b", 5);
    const c = clock();
    const cache = new PathCache(6);
    const a = cache.sampler(project, sym, anim, 1, c.now)(0);
    expect(cache.sampler(project, sym, other, 1, c.now)(0)).not.toBe(a);
  });

  it("past its budget with nothing to show, leaves a frame for a later draw unless forced", () => {
    const { project, sym, anim } = scene();
    const c = clock();
    const cache = new PathCache(6);
    const first = cache.sampler(project, sym, anim, 1, c.now);
    c.tick(10);
    expect(first(3)).toBeNull();
    expect(cache.pending).toBe(true);
    const forced = first(3, true);
    expect(forced).not.toBeNull();
    expect(cache.sampler(project, sym, anim, 1, c.now)(3)).toBe(forced);
  });
});

describe("bone path preferences", () => {
  it("default to the tip of the selected bones, and drop values outside the choices", () => {
    const p = mergePrefs({ gizmos: { bonePathPoint: "middle", bonePathBones: "all", showBonePaths: false } });
    expect(p.gizmos.bonePathPoint).toBe("tip");
    expect(p.gizmos.bonePathBones).toBe("all");
    expect(p.gizmos.showBonePaths).toBe(false);
    expect(mergePrefs({}).gizmos).toMatchObject({ showBonePaths: true, bonePathPoint: "tip", bonePathBones: "selected" });
  });
});
