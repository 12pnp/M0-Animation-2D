import { beforeAll, describe, expect, it } from "vitest";
import { ikPathDrag, ikTargetFor, targetLocalAt, withBendFlippedAt, withTargetAt, type IkPathDrag, type Point } from "@/core/doc/ikPathEdit";
import { pathDragMode } from "@/core/doc/pathEdit";
import { apply } from "@/core/math/Matrix2D";
import { posedSymbol } from "@/core/spine/spinePose";
import type { Animation, IkConstraint, Project, SymbolItem } from "@/core/doc/types";
import type { NodeId } from "@/core/doc/ids";
import { loadStickman, type Stickman } from "./fixtures/stickman";
import { History } from "@/core/history/History";
import { EditTracks, EditTracksAndIk, SetIkKeys } from "@/core/history/timelineCommands";

let s: Stickman, project: Project, rig: SymbolItem, run: Animation;
beforeAll(async () => {
  s = await loadStickman();
  ({ project, rig } = s);
  run = rig.animations.find((a) => a.name === "run")!;
});

const legIk = (): IkConstraint => rig.ik.find((k) => k.boneId === s.node("leg_near_shin"))!;

/** Drag `drag` at `frame` by `delta`; the pose with the target keyed where it says. */
function dragged(sym: SymbolItem, anim: Animation, drag: IkPathDrag, frame: number, delta: Point) {
  const k = sym.ik.find((c) => c.id === drag.ik)!;
  const start = posedSymbol(project, sym, anim, frame, "animate");
  const poseWith = (w: Point, flip: boolean) => posedSymbol(project, sym,
    withTargetAt(flip ? withBendFlippedAt(anim, k, frame) : anim, sym, k.targetId, frame, targetLocalAt(start, k.targetId, w)!), frame, "animate");
  const fit = ikTargetFor(sym, drag, start, delta, poseWith);
  return { start, after: fit ? poseWith(fit.target, fit.flip) : null, flip: fit?.flip ?? false, k };
}

const origin = (p: ReturnType<typeof posedSymbol>, id: NodeId) => { const m = p.byNode.get(id)!.world; return { x: m.tx, y: m.ty }; };
const tip = (p: ReturnType<typeof posedSymbol>, id: NodeId) =>
  apply({ x: 0, y: 0 }, p.byNode.get(id)!.world, (rig.nodes[id]!.boneLength ?? 40), 0);
const angle = (p: ReturnType<typeof posedSymbol>, id: NodeId) => {
  const a = origin(p, id), b = tip(p, id);
  return Math.atan2(b.y - a.y, b.x - a.x);
};

describe("dragging an IK chain's path keys its target", () => {
  it("the shin's tip lands on the pointer at every frame of the run", () => {
    const drag = { ik: legIk().id, role: "tip" } as const;
    const shin = s.node("leg_near_shin");
    for (let f = 0; f < run.duration; f++) {
      const delta = { x: 6, y: -9 };
      const { start, after } = dragged(rig, run, drag, f, delta);
      const want = tip(start, shin), got = tip(after!, shin);
      expect(Math.hypot(got.x - want.x - delta.x, got.y - want.y - delta.y), `frame ${f}`).toBeLessThan(1e-2);
    }
  });

  it("out of reach the leg points straight at the pointer", () => {
    const drag = { ik: legIk().id, role: "tip" } as const;
    const thigh = s.node("leg_near_thigh"), shin = s.node("leg_near_shin");
    const { start, after } = dragged(rig, run, drag, 3, { x: 0, y: 400 });
    const goal = { x: tip(start, shin).x, y: tip(start, shin).y + 400 };
    const r = origin(after!, thigh);
    const toGoal = Math.atan2(goal.y - r.y, goal.x - r.x);
    expect(Math.abs(angle(after!, thigh) - toGoal)).toBeLessThan(1e-3);
    expect(Math.abs(angle(after!, shin) - toGoal)).toBeLessThan(1e-3);
  });

  it("the knee turns about the hip and the shin keeps its angle", () => {
    const drag = { ik: legIk().id, role: "joint" } as const;
    const thigh = s.node("leg_near_thigh"), shin = s.node("leg_near_shin");
    const f = 5;
    const { start, after } = dragged(rig, run, drag, f, { x: 4, y: -3 });
    expect(after).not.toBeNull();
    expect(Math.abs(angle(after!, shin) - angle(start, shin))).toBeLessThan(1e-4);
    // The knee moved toward the pointer, on the thigh's circle.
    const k0 = origin(start, shin), k1 = origin(after!, shin);
    expect(Math.hypot(k1.x - k0.x, k1.y - k0.y)).toBeGreaterThan(1);
    const r = origin(after!, thigh);
    expect(Math.hypot(k1.x - r.x, k1.y - r.y)).toBeCloseTo(Math.hypot(k0.x - r.x, k0.y - r.y), 3);
  });

  it("a knee pulled across the leg keys the bend flipped, and lands there", () => {
    const drag = { ik: legIk().id, role: "joint" } as const;
    const thigh = s.node("leg_near_thigh"), shin = s.node("leg_near_shin");
    const start = posedSymbol(project, rig, run, 5, "animate");
    const r = origin(start, thigh), t = tip(start, shin), k = origin(start, shin);
    // The thigh turned past the shin's line: the leg would bend the other way.
    const ux = t.x - k.x, uy = t.y - k.y, l = Math.hypot(ux, uy);
    const was = Math.sign((k.x - r.x) * uy - (k.y - r.y) * ux);
    const phi = Math.atan2(uy, ux) + was * 0.1, l1 = Math.hypot(k.x - r.x, k.y - r.y);
    const knee = { x: r.x + l1 * Math.cos(phi), y: r.y + l1 * Math.sin(phi) };
    expect(l).toBeGreaterThan(0);
    const out = dragged(rig, run, drag, 5, { x: knee.x - k.x, y: knee.y - k.y });
    expect(out.flip).toBe(true);
    const k1 = origin(out.after!, shin);
    expect(Math.hypot(k1.x - knee.x, k1.y - knee.y)).toBeLessThan(1e-2);
    expect(Math.abs(angle(out.after!, shin) - angle(start, shin))).toBeLessThan(1e-4);
    // Short of the line it does not flip.
    expect(dragged(rig, run, drag, 5, { x: 2, y: -2 }).flip).toBe(false);
  });

  it("a look-at chain points at the pointer", () => {
    const sym: SymbolItem = { ...rig, ik: rig.ik.map((k) => (k.id === legIk().id ? { ...k, chain: 0 as const } : k)) };
    const drag = ikPathDrag(sym, s.node("leg_near_shin"), "tip");
    expect(drag).toEqual({ ik: legIk().id, role: "aim" });
    const shin = s.node("leg_near_shin");
    const { start, after } = dragged(sym, run, drag as IkPathDrag, 2, { x: 20, y: 5 });
    const o = origin(after!, shin), goal = { x: tip(start, shin).x + 20, y: tip(start, shin).y + 5 };
    expect(Math.abs(angle(after!, shin) - Math.atan2(goal.y - o.y, goal.x - o.x))).toBeLessThan(1e-3);
  });

  it("a partial weight still lands", () => {
    const sym: SymbolItem = { ...rig, ik: rig.ik.map((k) => (k.id === legIk().id ? { ...k, weight: 0.6 } : k)) };
    const shin = s.node("leg_near_shin");
    const { start, after } = dragged(sym, run, { ik: legIk().id, role: "tip" }, 4, { x: -5, y: 5 });
    const want = tip(start, shin), got = tip(after!, shin);
    expect(Math.hypot(got.x - want.x + 5, got.y - want.y - 5)).toBeLessThan(0.5);
  });

  it("refuses a locked target, and no weight is the bone's own keys", () => {
    const target = legIk().targetId;
    const locked: SymbolItem = { ...rig, layers: rig.layers.map((l) => (l.nodeId === target ? { ...l, locked: true } : l)) };
    expect(ikPathDrag(locked, s.node("leg_near_shin"), "tip")).toEqual({ refused: expect.stringContaining("locked") });
    const off: SymbolItem = { ...rig, ik: rig.ik.map((k) => (k.id === legIk().id ? { ...k, weight: 0 } : k)) };
    expect(ikPathDrag(off, s.node("leg_near_shin"), "tip")).toBeNull();
    expect("mode" in pathDragMode(off, run, s.node("leg_near_shin"), "tip", false)).toBe(true);
  });
});

describe("a knee drag's bend flip in the history", () => {
  it("flipped, then pulled back: one undo step, and the bend keys as they were", async () => {
    const { project, rig } = await loadStickman();
    const anim = rig.animations[0]!;
    const k = rig.ik[0]!;
    const history = new History(project);
    const base = { ...anim };
    const step = (flip: boolean, x: number) => {
      const target = base.tracks[k.targetId]!;
      const tracks = new Map([[k.targetId, { ...target, keys: target.keys.map((key, i) => (i ? key : { ...key, transform: { ...key.transform, x } })) }]]);
      const keys = (flip ? withBendFlippedAt(base, k, 3) : base).ik?.[k.id] ?? [];
      return new EditTracksAndIk("Drag Path (IK)", new EditTracks("Drag Path (IK)", rig.id, anim.id, tracks, "path.drag"),
        new SetIkKeys("Drag Path (IK)", rig.id, anim.id, k.id, keys, "path.drag"), "path.drag");
    };
    const x0 = base.tracks[k.targetId]!.keys[0]!.transform.x;
    history.beginInteraction("path.drag");
    history.apply(step(true, x0 + 5));
    const now = () => (project.items[rig.id] as SymbolItem).animations[0]!;
    expect(now().ik?.[k.id]).toEqual([{ frame: 3, mix: k.weight, bendPositive: !k.bendPositive }]);
    history.apply(step(false, x0 + 9));
    history.endInteraction();
    expect(now().ik).toBeUndefined();
    expect(history.position).toBe(1);
    history.apply(step(true, x0 + 1));
    history.undo();
    expect(now().ik).toBeUndefined();
    history.undo();
    expect(now().tracks[k.targetId]!.keys[0]!.transform.x).toBe(x0);
  });
});
