import { beforeEach, describe, expect, it } from "vitest";
import { reseed, type IkId, type NodeId, type TcId } from "@/core/doc/ids";
import { createAnimation, createNode, createProject } from "@/core/doc/defaults";
import type { Animation, SymbolItem } from "@/core/doc/types";
import type { Command } from "@/core/history/Command";
import { SetDrawOrder, SetIkKeys } from "@/core/history/timelineCommands";
import { SetTcKeys } from "@/core/history/transformCommands";
import { SetDeformKeys } from "@/core/history/meshCommands";
import { SetInheritKeys, SetSequenceKeys } from "@/core/history/attachmentCommands";

beforeEach(() => reseed());

/** The key-list commands share one shape (`SetAnimKeys`); these hold what each
 *  wrote, undid and merged before they did. */
function scene() {
  const project = createProject("P");
  const sym = project.items[project.rootSymbolId] as SymbolItem;
  const anim = createAnimation("a", 10);
  sym.animations = [anim];
  const n = createNode("image", "n");
  sym.nodes[n.id] = n;
  return { project, sym, sid: sym.id, aid: anim.id, node: n.id };
}
const animOf = (sym: SymbolItem): Animation => sym.animations[0]!;
const ik = "ik1" as IkId, ik2 = "ik2" as IkId, tc = "tc1" as TcId;

describe("key list commands", () => {
  it.each([
    ["ik", (s: ReturnType<typeof scene>, keys: number[]) => new SetIkKeys("L", s.sid, s.aid, ik, keys.map((f) => ({ frame: f, mix: 1, bendPositive: true }))),
      (a: Animation) => a.ik?.[ik]?.map((k) => k.frame)],
    ["transform", (s: ReturnType<typeof scene>, keys: number[]) => new SetTcKeys("L", s.sid, s.aid, tc, keys.map((f) => ({ frame: f, mix: { rotate: 1, x: 1, y: 1, scaleX: 1, scaleY: 1, shearY: 1 } }))),
      (a: Animation) => a.transforms?.[tc]?.map((k) => k.frame)],
    ["draw order", (s: ReturnType<typeof scene>, keys: number[]) => new SetDrawOrder("L", s.sid, s.aid, keys.map((f) => ({ frame: f }))),
      (a: Animation) => a.drawOrder?.map((k) => k.frame)],
    ["deform", (s: ReturnType<typeof scene>, keys: number[]) => new SetDeformKeys("L", s.sid, s.aid, s.node, keys.map((f) => ({ frame: f, offsets: [0, 0] }))),
      (a: Animation) => a.deforms?.[s0().node]?.map((k) => k.frame)],
    ["sequence", (s: ReturnType<typeof scene>, keys: number[]) => new SetSequenceKeys("L", s.sid, s.aid, s.node, keys.map((f) => ({ frame: f, mode: "hold" as const, index: 0, delay: 1 }))),
      (a: Animation) => a.sequences?.[s0().node]?.map((k) => k.frame)],
    ["inherit", (s: ReturnType<typeof scene>, keys: number[]) => new SetInheritKeys("L", s.sid, s.aid, s.node, keys.map((f) => ({ frame: f, inherit: "normal" as const }))),
      (a: Animation) => a.inherits?.[s0().node]?.map((k) => k.frame)],
  ] as const)("%s keys: write, undo to absent, redo", (_n, make, read) => {
    const s = (current = scene());
    const c = make(s, [0, 4]);
    c.apply(s.project);
    expect(read(animOf(s.sym))).toEqual([0, 4]);
    c.revert(s.project);
    expect(read(animOf(s.sym))).toBeUndefined();
    c.apply(s.project);
    const empty = make(s, []);
    empty.apply(s.project);
    expect(read(animOf(s.sym))).toBeUndefined();
    empty.revert(s.project);
    expect(read(animOf(s.sym))).toEqual([0, 4]);
  });

  it("merges steps of one drag, only on the same list", () => {
    const s = scene();
    const a: Command = new SetIkKeys("L", s.sid, s.aid, ik, [], "drag");
    expect(a.mergeWith!(new SetIkKeys("L", s.sid, s.aid, ik, [], "drag"))).toBe(true);
    expect(a.mergeWith!(new SetIkKeys("L", s.sid, s.aid, ik2, [], "drag"))).toBe(false);
    expect(a.mergeWith!(new SetIkKeys("L", s.sid, s.aid, ik, [], "other"))).toBe(false);
    expect(a.mergeWith!(new SetTcKeys("L", s.sid, s.aid, tc, [], "drag"))).toBe(false);
    // IK keys merge at their default kind; sequence keys at theirs never do.
    expect(new SetIkKeys("L", s.sid, s.aid, ik, []).mergeWith(new SetIkKeys("L", s.sid, s.aid, ik, []))).toBe(true);
    expect(new SetSequenceKeys("L", s.sid, s.aid, s.node, []).mergeWith(new SetSequenceKeys("L", s.sid, s.aid, s.node, []))).toBe(false);
    expect(new SetSequenceKeys("L", s.sid, s.aid, s.node, [], "drag").mergeWith(new SetSequenceKeys("L", s.sid, s.aid, s.node, [], "drag"))).toBe(true);
    expect(new SetSequenceKeys("L", s.sid, s.aid, s.node, [], "drag").mergeWith(new SetInheritKeys("L", s.sid, s.aid, s.node, [], "drag"))).toBe(false);
  });

  it("merged, undo goes back to before the first step", () => {
    const s = scene();
    const first = new SetDrawOrder("L", s.sid, s.aid, [{ frame: 1 }], "drag");
    first.apply(s.project);
    const second = new SetDrawOrder("L", s.sid, s.aid, [{ frame: 2 }], "drag");
    expect(first.mergeWith(second)).toBe(true);
    first.apply(s.project);
    expect(animOf(s.sym).drawOrder).toEqual([{ frame: 2 }]);
    first.revert(s.project);
    expect(animOf(s.sym).drawOrder).toBeUndefined();
  });

  it("touches the node only for per-node lists", () => {
    const s = scene();
    expect(new SetIkKeys("L", s.sid, s.aid, ik, []).touches.nodes).toBeUndefined();
    expect(new SetDeformKeys("L", s.sid, s.aid, s.node, []).touches.nodes).toEqual([s.node as NodeId]);
  });
});

let current: ReturnType<typeof scene>;
const s0 = () => current;
