import { beforeAll, describe, expect, it } from "vitest";
import {
  channelKeys, deleteChannelKeys, keyChannelAt, moveChannelKeys, propertyKeys, setChannel,
  TIMELINE_PROPS, type TimelineProp,
} from "@/core/doc/propertyKeys";
import { sampleTransformRaw } from "@/core/doc/timeline";
import { createLayer, createNode, createProject } from "@/core/doc/defaults";
import { migrate, validateProject } from "@/core/doc/schema";
import { withKeyframe } from "@/core/history/timelineCommands";
import { tf, type Transform } from "@/core/math/Transform";
import { applyTween, TWEEN_LINEAR, type TweenSpec } from "@/core/math/easing";
import type { Node, Project, SymbolItem, Track } from "@/core/doc/types";
import type { NodeId } from "@/core/doc/ids";
import { loadStickman } from "./fixtures/stickman";

/** Each property's numbers, rotation folded into one turn. */
const leaves = (t: Transform) => ({
  rotate: [(((t.skewY % 360) + 540) % 360) - 180],
  x: [t.x], y: [t.y], scale: [t.scaleX, t.scaleY], shear: [t.skewY - t.skewX],
});

/** Every whole frame of the two tracks agrees on the properties in `props`. */
function expectSame(a: Track, b: Track, props: readonly TimelineProp[]): void {
  for (let f = 0; f <= Math.max(a.endFrame, b.endFrame); f++) {
    const ta = sampleTransformRaw(a, f), tb = sampleTransformRaw(b, f);
    expect(!!ta, `frame ${f}`).toBe(!!tb);
    if (!ta || !tb) continue;
    const la = leaves(ta), lb = leaves(tb);
    for (const p of props) {
      la[p].forEach((v, i) => expect(Math.abs(v - lb[p][i]!), `${p} at frame ${f}`).toBeLessThan(1e-4));
    }
  }
}

const others = (p: TimelineProp) => TIMELINE_PROPS.filter((q) => q !== p);

function track(...keys: Array<[number, Transform, TweenSpec?]>): Track {
  return {
    nodeId: "n" as NodeId, endFrame: 40,
    keys: keys.map(([frame, transform, tween]) => ({ frame, transform, displayIndex: 0, tween: tween ?? TWEEN_LINEAR })),
  };
}
const bone: Node = createNode("bone", "b");
const easeIn: TweenSpec = { kind: "curve", curve: [0.6, 0, 0.9, 0.4] };

describe("a property rewritten as it was changes nothing", () => {
  let project: Project, rig: SymbolItem;
  beforeAll(async () => { ({ project, rig } = await loadStickman()); });

  it("every stickman track, every property, every frame", () => {
    let checked = 0;
    for (const anim of rig.animations) {
      for (const t of Object.values(anim.tracks)) {
        const node = rig.nodes[t.nodeId]!;
        for (const p of TIMELINE_PROPS) {
          expectSame(t, setChannel(t, node, p, channelKeys(t, p)), TIMELINE_PROPS);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(project).toBeTruthy();
  });
});

describe("editing one property leaves the others", () => {
  // Rotation keyed at 0, 10, 30; x at 0 and 20, eased in.
  const t = track(
    [0, tf(0, 0, 0, 0), easeIn],
    [10, tf(5, 0, 40, 40), easeIn],
    [20, tf(10, 0, 40, 40)],
    [30, tf(10, 0, 90, 90)],
  );

  it("moving a rotate key", () => {
    const out = moveChannelKeys(t, bone, "rotate", [10], 4);
    expectSame(t, out, others("rotate"));
    expect(propertyKeys(out, "rotate")).toContain(14);
    expect(sampleTransformRaw(out, 14)!.skewY).toBeCloseTo(40, 6);
  });

  it("deleting a rotate key: from the key before to the key after, on the first one's ease", () => {
    // Rotate keys at 0, 10, 20 (40 held to there) and 30.
    expect(propertyKeys(t, "rotate")).toEqual([0, 10, 20, 30]);
    const out = deleteChannelKeys(t, bone, "rotate", [10]);
    expectSame(t, out, others("rotate"));
    expect(propertyKeys(out, "rotate")).toEqual([0, 20, 30]);
    // 0 to 40 over frames 0..20 on key 0's ease, read halfway
    expect(sampleTransformRaw(out, 10)!.skewY).toBeCloseTo(40 * applyTween(easeIn, 0.5, 20), 4);
  });

  it("keying a property in the middle of its ease moves nothing", () => {
    const out = keyChannelAt(t, bone, "x", 15);
    expectSame(t, out, TIMELINE_PROPS);
    expect(propertyKeys(out, "x")).toContain(15);
  });

  it("a whole key that carried only the moved property goes", () => {
    const only = track([0, tf(0, 0, 0, 0)], [10, tf(0, 0, 30, 30)], [20, tf(0, 0, 30, 30)], [30, tf(9, 0, 30, 30)]);
    const out = moveChannelKeys(only, bone, "rotate", [10], 3);
    expect(out.keys.map((k) => k.frame)).not.toContain(10);
    expect(out.keys.map((k) => k.frame)).toContain(13);
    expectSame(only, out, others("rotate"));
  });

  it("a key moved onto another key of the same property replaces it", () => {
    const out = moveChannelKeys(t, bone, "rotate", [10], 20);
    expect(propertyKeys(out, "rotate")).toEqual([0, 20, 30]);
    expect(sampleTransformRaw(out, 30)!.skewY).toBeCloseTo(40, 6);
    expectSame(t, out, others("rotate"));
  });

  it("turns written as rotateTurns read as the angle reached", () => {
    const spun: Track = {
      ...track([0, tf(0, 0, 0, 0)], [10, tf(4, 0, 0, 0)], [20, tf(4, 0, 10, 10)]),
    };
    spun.keys[0] = { ...spun.keys[0]!, rotateTurns: 1 };
    expectSame(spun, setChannel(spun, bone, "rotate", channelKeys(spun, "rotate")), TIMELINE_PROPS);
    expect(propertyKeys(spun, "rotate")).toEqual([0, 10, 20]);
  });
});

describe("Keyframe.keyed", () => {
  const t = track([0, tf(0, 0, 0, 0)], [10, tf(5, 0, 0, 0)], [20, tf(5, 0, 0, 0)]);

  it("keying a property that never changes shows one key on its row", () => {
    const out = keyChannelAt(t, bone, "rotate", 20);
    expect(propertyKeys(out, "rotate")).toEqual([20]);
    expectSame(t, out, TIMELINE_PROPS);
  });

  it("a pose set at a key keys what it changed", () => {
    const marked = keyChannelAt(t, bone, "rotate", 20);
    expect(propertyKeys(marked, "x")).toEqual([0, 10]);
    const posed = withKeyframe(marked, 10, { transform: tf(5, 0, 25, 25) });
    expect(posed.keys.find((k) => k.frame === 10)!.keyed).toEqual(["rotate", "x"]);
    // Frame 0 still holds 0 there, so it is one of rotate's keys now too.
    expect(propertyKeys(posed, "rotate")).toEqual([0, 10, 20]);
  });

  it("a file's list is kept to known properties, in order", () => {
    const project = createProject("K");
    const sym = project.items[project.rootSymbolId] as SymbolItem;
    const b = createNode("bone", "b");
    sym.nodes[b.id] = b;
    sym.layers.push(createLayer(b.id, "b", 0));
    sym.animations[0]!.tracks[b.id] = {
      nodeId: b.id, endFrame: 10,
      keys: [{ frame: 0, transform: tf(), displayIndex: 0, tween: TWEEN_LINEAR, keyed: ["x", "wing", "rotate"] as never }],
    };
    const raw = JSON.parse(JSON.stringify({ ...project, version: 14 }));
    const out = validateProject(migrate(raw)).project;
    const key = (out.items[out.rootSymbolId] as SymbolItem).animations[0]!.tracks[b.id]!.keys[0]!;
    expect(out.version).toBe(15);
    expect(key.keyed).toEqual(["rotate", "x"]);
  });
});
