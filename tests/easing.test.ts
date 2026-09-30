import { describe, it, expect, beforeEach } from "vitest";
import { RotateTimeline } from "@esotericsoftware/spine-core";
import {
  EASE_FAMILIES, applyTween, easeFunction, exportNote, easeLabel, easeSegments, idealEase, readPolyline, spinePolyline,
  easeOf, splitTween, type EaseDir, type EaseSegment, type EaseSpec,
} from "@/core/math/easing";
import {
  anchorsOf, constrain, curveValueAt, insertAnchor, moveAnchor, moveHandle, removeAnchor, toCorner,
} from "@/core/math/easeCurve";
import { reseed } from "@/core/doc/ids";
import { tf } from "@/core/math/Transform";
import type { Track } from "@/core/doc/types";
import { sampleTransformRaw, insertKeyframe } from "@/core/doc/timeline";
import { migrate, validateProject } from "@/core/doc/schema";
import { createProject, createLayer, createNode } from "@/core/doc/defaults";

beforeEach(() => reseed());

/**
 * The runtime's own evaluation of one bezier segment: a two-key
 * RotateTimeline from spine-core 4.3.13 with `setBezier` on it, read with
 * `getCurveValue`. Absolute units, as a file carries them.
 */
function runtimeCurve(seg: EaseSegment, t0: number, t1: number, v0: number, v1: number): (time: number) => number {
  const tl = new RotateTimeline(2, 1, 0);
  const tx = (x: number) => t0 + x * (t1 - t0), vy = (y: number) => v0 + y * (v1 - v0);
  tl.setFrame(0, tx(seg.x0), vy(seg.y0));
  tl.setFrame(1, tx(seg.x1), vy(seg.y1));
  tl.setBezier(0, 0, 0, tx(seg.x0), vy(seg.y0), tx(seg.c1x), vy(seg.c1y), tx(seg.c2x), vy(seg.c2y), tx(seg.x1), vy(seg.y1));
  return (time) => tl.getCurveValue(time);
}

function randomSegments(n: number): EaseSegment[] {
  let seed = 7;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  return Array.from({ length: n }, () => {
    const c1x = r(), c2x = r();
    return { x0: 0, y0: 0, c1x, c1y: (r() - 0.3) * 3, c2x: Math.max(c1x, c2x), c2y: (r() - 0.3) * 3, x1: 1, y1: 1 };
  });
}

const DIRS: EaseDir[] = ["in", "out", "inOut"];

describe("the runtime's curve sampler", () => {
  it("the port reads a segment as spine-core does, in any units", () => {
    for (const seg of randomSegments(60)) {
      const pts = spinePolyline(seg);
      for (const [t0, t1, v0, v1] of [[0, 1, 0, 1], [0.5, 1.25, 30, -210], [2, 2.0416667, 5, 5.5]] as const) {
        const rt = runtimeCurve(seg, t0, t1, v0, v1);
        for (let i = 0; i <= 40; i++) {
          const x = i / 40;
          const want = rt(t0 + x * (t1 - t0));
          const got = v0 + readPolyline(pts, x) * (v1 - v0);
          // Float32 frames and curves in the runtime.
          expect(Math.abs(got - want)).toBeLessThan(2e-4 * Math.max(1, Math.abs(v1 - v0)));
        }
      }
    }
  });

  it("is the polyline through the curve at parameter 0.1 … 0.9, not the curve", () => {
    const seg = easeSegments({ kind: "curve", curve: [0.9, 0, 0.1, 1] })![0]!;
    const pts = spinePolyline(seg);
    // At a sample point the two agree; half way between, the chord is off.
    expect(readPolyline(pts, pts[10]!)).toBeCloseTo(idealEase({ kind: "curve", curve: [0.9, 0, 0.1, 1] }, pts[10]!), 9);
    const mid = (pts[10]! + pts[12]!) / 2;
    expect(Math.abs(readPolyline(pts, mid) - idealEase({ kind: "curve", curve: [0.9, 0, 0.1, 1] }, mid))).toBeGreaterThan(1e-3);
  });
});

describe("the Ease dialog's note on what the export writes", () => {
  it("names keys and beziers, per kind", () => {
    expect(exportNote({ kind: "linear" }, 12)).toBe("12 frames · one straight key");
    expect(exportNote({ kind: "ease", value: 1 }, 12)).toBe("12 frames · 1 bezier, which Spine plays as 10 straight pieces");
    expect(exportNote({ kind: "curve", curve: [0.1, 0.4, 0.2, 0.6, 0.3, 0.7, 0.45, 0.8, 0.6, 0.9] }, 1))
      .toBe("1 frame · 2 beziers, which Spine plays as 20 straight pieces");
    expect(exportNote({ kind: "preset", family: "bounce", dir: "out" }, 30)).toBe("30 frames · no bezier holds this ease: 30 keys, one per frame");
  });
});

describe("the quad eases are cubics", () => {
  it("whose curve is exactly their polynomial", () => {
    for (const value of [-2, -1, -0.4, 0.3, 1, 1.5, 2]) {
      const seg = easeSegments({ kind: "ease", value })![0]!;
      for (let i = 0; i <= 20; i++) {
        const t = i / 20, l = 1 - t;
        const x = 3 * l * l * t * seg.c1x + 3 * l * t * t * seg.c2x + t * t * t;
        const y = 3 * l * l * t * seg.c1y + 3 * l * t * t * seg.c2y + t * t * t;
        expect(x).toBeCloseTo(t, 12);
        expect(y).toBeCloseTo(idealEase({ kind: "ease", value }, t), 12);
      }
    }
  });

  it("in pulls away slowly, out arrives slowly, in-out does both", () => {
    expect(applyTween({ kind: "ease", value: -1 }, 0.25, 10)).toBeLessThan(0.25);
    expect(applyTween({ kind: "ease", value: 1 }, 0.25, 10)).toBeGreaterThan(0.25);
    const io = { kind: "ease", value: 2 } as const;
    expect(applyTween(io, 0.25, 10)).toBeLessThan(0.25);
    expect(applyTween(io, 0.75, 10)).toBeGreaterThan(0.75);
    expect(applyTween(io, 0.5, 10)).toBeCloseTo(0.5, 9);
  });

  it("a multi-segment custom curve is one bezier per segment", () => {
    const segs = easeSegments({ kind: "curve", curve: [0.1, 0.4, 0.2, 0.6, 0.3, 0.7, 0.45, 0.8, 0.6, 0.9] })!;
    expect(segs.map((x) => [x.x0, x.y0, x.x1, x.y1])).toEqual([[0, 0, 0.3, 0.7], [0.3, 0.7, 1, 1]]);
  });
});

describe("preset eases", () => {
  it("start at 0 and end at 1 in every family and direction", () => {
    for (const fam of EASE_FAMILIES) {
      for (const dir of DIRS) {
        const f = easeFunction({ family: fam.id, dir });
        expect(f(0)).toBeCloseTo(0, 2);
        expect(f(1)).toBeCloseTo(1, 2);
      }
    }
  });

  it("bounce at the default bounciness is Penner's bounce", () => {
    const penner = (p: number) => {
      if (p < 1 / 2.75) return 7.5625 * p * p;
      if (p < 2 / 2.75) { p -= 1.5 / 2.75; return 7.5625 * p * p + 0.75; }
      if (p < 2.5 / 2.75) { p -= 2.25 / 2.75; return 7.5625 * p * p + 0.9375; }
      p -= 2.625 / 2.75; return 7.5625 * p * p + 0.984375;
    };
    const f = easeFunction({ family: "bounce", dir: "out" });
    for (let p = 0; p <= 1; p += 0.05) expect(f(p)).toBeCloseTo(penner(p), 6);
  });

  it("the stage shows the exact ease at every whole frame, straight between", () => {
    for (const fam of EASE_FAMILIES) {
      for (const dir of DIRS) {
        const spec = { kind: "preset" as const, family: fam.id, dir };
        const f = easeFunction(spec);
        for (const n of [5, 24]) {
          for (let k = 0; k <= n; k++) expect(applyTween(spec, k / n, n)).toBeCloseTo(k === 0 ? 0 : k === n ? 1 : f(k / n), 12);
          const half = applyTween(spec, 2.5 / n, n);
          expect(half).toBeCloseTo((f(2 / n) + f(3 / n)) / 2, 12);
        }
      }
    }
  });

  it("has no cubic, so the file carries a key per frame", () => {
    expect(easeSegments({ kind: "preset", family: "bounce", dir: "out" })).toBeNull();
  });

  it("labels", () => {
    expect(easeLabel({ kind: "preset", family: "bounce", dir: "inOut" })).toBe("bounce in-out");
    expect(easeLabel({ kind: "curve", curve: [0.4, 0, 0.6, 1] })).toBe("custom");
    expect(easeLabel({ kind: "ease", value: -0.5 })).toBe("ease in");
  });
});

describe("cutting an eased interval", () => {
  /** The original ease at every whole frame, against the two halves joined. */
  function worstFrame(spec: EaseSpec, span: number, at: number): number {
    const [a, b] = splitTween(spec, span, at)!;
    const eu = applyTween(spec, at / span, span);
    let worst = 0;
    for (let f = 0; f <= span; f++) {
      const joined = f <= at
        ? eu * applyTween(a, f / at, at)
        : eu + (1 - eu) * applyTween(b, (f - at) / (span - at), span - at);
      worst = Math.max(worst, Math.abs(joined - applyTween(spec, f / span, span)));
    }
    return worst;
  }

  it("lands on the original ease at every frame, for every kind", () => {
    const specs: EaseSpec[] = [
      { kind: "ease", value: -1 }, { kind: "ease", value: 0.6 }, { kind: "ease", value: 2 },
      { kind: "preset", family: "back", dir: "out" }, { kind: "preset", family: "bounce", dir: "out" },
      { kind: "curve", curve: [0.1, 0.8, 0.3, 1] },
    ];
    for (const spec of specs) {
      for (const [span, at] of [[20, 5], [20, 9], [12, 3], [40, 17], [3, 1]] as const) {
        expect(worstFrame(spec, span, at), `${easeLabel(spec)} ${span}/${at}`).toBeLessThan(1e-4);
      }
    }
  });

  it("cuts into straight pieces, which Spine plays exactly", () => {
    const [a, b] = splitTween({ kind: "ease", value: -1 }, 20, 5)!;
    expect(a.kind).toBe("curve");
    expect(b.kind).toBe("curve");
    expect(splitTween({ kind: "linear" }, 20, 9)).toEqual([{ kind: "linear" }, { kind: "linear" }]);
  });

  it("refuses a cut with no progress on one side, or past the curve range", () => {
    // Anticipation back to the start: no progress at all in the first half.
    expect(splitTween({ kind: "ease", value: -2 }, 2, 1)).toBeNull();
    // Elastic out has already overshot 1 here: the second half would need
    // values far past the document's ±3.27.
    expect(splitTween({ kind: "preset", family: "elastic", dir: "out" }, 20, 5)).toBeNull();
  });
});

describe("custom curve editing", () => {
  const base = [0.42, 0, 0.58, 1];

  it("inserting an anchor leaves the curve's shape unchanged", () => {
    const { curve, index } = insertAnchor(base, 0.3);
    expect(index).toBe(1);
    expect(curve.length).toBe(10);
    for (let x = 0.02; x < 1; x += 0.05) {
      expect(curveValueAt(curve, x)).toBeCloseTo(curveValueAt(base, x), 4);
    }
    // The runtime reads each segment through its own ten pieces, so two
    // segments read finer than one: close, not identical.
    for (let x = 0.02; x < 1; x += 0.05) {
      expect(Math.abs(applyTween({ kind: "curve", curve }, x, 30) - applyTween({ kind: "curve", curve: base }, x, 30))).toBeLessThan(0.01);
    }
  });

  it("removing it goes back to one segment", () => {
    const { curve } = insertAnchor(base, 0.5);
    expect(removeAnchor(curve, 1).length).toBe(4);
    expect(removeAnchor(curve, 0)).toEqual(curve);
  });

  it("keeps anchors ordered and every segment's x monotone", () => {
    let { curve } = insertAnchor(base, 0.3);
    curve = insertAnchor(curve, 0.7).curve;
    curve = moveAnchor(curve, 1, 0.95, 2);
    curve = moveHandle(curve, 2, "in", -1, 0.5, true);
    const a = anchorsOf(curve);
    for (let i = 0; i < a.length - 1; i++) {
      expect(a[i + 1]!.x).toBeGreaterThan(a[i]!.x);
      expect(a[i]!.x).toBeLessThanOrEqual(a[i]!.outX);
      expect(a[i]!.outX).toBeLessThanOrEqual(a[i + 1]!.inX);
      expect(a[i + 1]!.inX).toBeLessThanOrEqual(a[i + 1]!.x);
    }
    expect(constrain(a)).toEqual(a);
  });

  it("a mirrored handle drags its partner round; a corner has none", () => {
    const { curve } = insertAnchor(base, 0.5);
    const moved = anchorsOf(moveHandle(curve, 1, "out", 0.7, 0.9, true))[1]!;
    const cross = (moved.outX - moved.x) * (moved.inY - moved.y) - (moved.outY - moved.y) * (moved.inX - moved.x);
    expect(cross).toBeCloseTo(0, 6);
    const corner = anchorsOf(toCorner(curve, 1))[1]!;
    expect([corner.inX, corner.inY, corner.outX, corner.outY]).toEqual([corner.x, corner.y, corner.x, corner.y]);
  });
});

describe("per-property eases", () => {
  function tweenTrack(): Track {
    return {
      nodeId: "n1" as Track["nodeId"],
      keys: [
        {
          frame: 0, transform: tf(0, 0, 0, 0, 1, 1), displayIndex: 0,
          tween: { kind: "linear" },
          eases: { rotation: { kind: "preset", family: "back", dir: "in" } },
        },
        { frame: 20, transform: tf(100, 0, 90, 90, 2, 2), displayIndex: 0, tween: { kind: "linear" } },
      ],
      endFrame: 20,
    };
  }

  it("the stage eases each channel on its own", () => {
    const s = sampleTransformRaw(tweenTrack(), 5)!;
    expect(s.x).toBeCloseTo(25, 6);
    expect(s.scaleX).toBeCloseTo(1.25, 6);
    expect(s.skewY).toBeCloseTo(90 * applyTween({ kind: "preset", family: "back", dir: "in" }, 0.25, 20), 6);
    expect(s.skewY).toBeLessThan(0);   // back in starts by pulling away
  });

  it("an axis's ease wins over its property's, which wins over the key's", () => {
    const sine: EaseSpec = { kind: "preset", family: "sine", dir: "in" };
    const back: EaseSpec = { kind: "preset", family: "back", dir: "in" };
    const k = { tween: { kind: "linear" } as const, eases: { position: sine, y: back, rotation: back } };
    expect(easeOf(k, "x")).toBe(sine);
    expect(easeOf(k, "y")).toBe(back);
    expect(easeOf(k, "shear")).toBe(back);
    expect(easeOf(k, "scaleX")).toEqual({ kind: "linear" });
    expect(easeOf({ ...k, tween: { kind: "none" } }, "y")).toEqual({ kind: "none" });
  });

  it("the stage eases x and y, and scale x and y, each on its own", () => {
    const t = tweenTrack();
    t.keys[0] = { ...t.keys[0]!, eases: { y: { kind: "preset", family: "sine", dir: "in" }, scaleX: { kind: "ease", value: 1 } } };
    t.keys[1] = { ...t.keys[1]!, transform: tf(100, 50, 0, 0, 2, 2) };
    const s = sampleTransformRaw(t, 5)!;
    expect(s.x).toBeCloseTo(25, 6);
    expect(s.y).toBeCloseTo(50 * applyTween({ kind: "preset", family: "sine", dir: "in" }, 0.25, 20), 6);
    expect(s.scaleY).toBeCloseTo(1.25, 6);
    expect(s.scaleX).toBeCloseTo(1 + applyTween({ kind: "ease", value: 1 }, 0.25, 20), 6);
    expect(s.scaleX).toBeGreaterThan(1.3);
  });

  it("the stage eases the shear (skewY − skewX) apart from the rotation (skewY)", () => {
    const shearEase: EaseSpec = { kind: "preset", family: "sine", dir: "in" };
    const t: Track = {
      nodeId: "n1" as Track["nodeId"],
      keys: [
        { frame: 0, transform: tf(0, 0, 0, 0), displayIndex: 0, tween: { kind: "linear" }, eases: { shear: shearEase } },
        { frame: 20, transform: tf(0, 0, 60, 80), displayIndex: 0, tween: { kind: "linear" } },
      ],
      endFrame: 20,
    };
    const s = sampleTransformRaw(t, 5)!;
    expect(s.skewY).toBeCloseTo(20, 6);
    expect(s.skewY - s.skewX).toBeCloseTo(20 * applyTween(shearEase, 0.25, 20), 6);
    // No shear override: both skews straight, as ever.
    delete t.keys[0]!.eases;
    const plain = sampleTransformRaw(t, 5)!;
    expect([plain.skewX, plain.skewY]).toEqual([15, 20]);
  });

  it("F6 inside a tween keeps the overrides on both halves", () => {
    const t = insertKeyframe(tweenTrack(), 10, createNode("image", "n"))!;
    expect(t.keys[1]!.eases?.rotation).toEqual({ kind: "preset", family: "back", dir: "in" });
  });
});

describe("schema", () => {
  it("keeps valid eases and drops what it cannot evaluate", () => {
    const project = createProject("T") as unknown as Record<string, unknown>;
    const { project: p0 } = validateProject(migrate(project));
    const sym = p0.items[p0.rootSymbolId] as unknown as { animations: Array<{ tracks: Record<string, unknown> }>; nodes: Record<string, unknown>; layers: unknown[] };
    const node = createNode("image", "n");
    sym.nodes[node.id] = node;
    sym.layers.unshift(createLayer(node.id, "n", 0));
    sym.animations[0]!.tracks[node.id] = {
      nodeId: node.id,
      endFrame: 10,
      keys: [
        {
          frame: 0, transform: tf(), displayIndex: 0,
          tween: { kind: "preset", family: "back", dir: "out", amount: 99 },
          eases: {
            position: { kind: "curve", curve: [0.1, 0.2, 0.3] },
            rotation: { kind: "wobble" },
            scale: { kind: "curve", curve: [0.2, 0, 0.8, 1] },
            y: { kind: "linear" },
            shear: { kind: "none" },
            bogus: { kind: "linear" },
          },
        },
        { frame: 10, transform: tf(), displayIndex: 0, tween: { kind: "sideways" } },
      ],
    };
    const { project: out } = validateProject(migrate(JSON.parse(JSON.stringify(p0))));
    const keys = (out.items[out.rootSymbolId] as unknown as typeof sym).animations[0]!.tracks[node.id] as Track;
    expect(keys.keys[0]!.tween).toEqual({ kind: "preset", family: "back", dir: "out", amount: 4 });
    expect(keys.keys[0]!.eases).toEqual({ y: { kind: "linear" }, scale: { kind: "curve", curve: [0.2, 0, 0.8, 1] } });
    expect(keys.keys[1]!.tween).toEqual({ kind: "linear" });
  });
});
