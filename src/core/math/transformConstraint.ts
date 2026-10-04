/**
 * Transform constraints, transcribed from the Spine runtime the preview runs:
 * `TransformConstraint.update`, the `From*` / `To*` properties of
 * `TransformConstraintData`, and `BonePose.updateLocalTransform` (normal
 * inherit) in @esotericsoftware/spine-core 4.3.13.
 *
 * Kept as the runtime has it, in its space: y UP, `a b c d` row-major with
 * `(a, c)` the x axis, the skeleton's scale 1, angles through the runtime's
 * own pi (3.1415927). `core/doc/pose.ts` maps the stage's bones in and out;
 * `tests/spineParity.test.ts` checks the result against spine-core itself.
 */

const PI = 3.1415927;
const PI2 = PI * 2;
const RAD_DEG = 180 / PI;
const DEG_RAD = PI / 180;
const EPSILON2 = 0.00001 * 0.00001;

export type TcChannel = "rotate" | "x" | "y" | "scaleX" | "scaleY" | "shearY";
export const TC_CHANNELS: readonly TcChannel[] = ["rotate", "x", "y", "scaleX", "scaleY", "shearY"];

/** A bone's world matrix, Spine's layout. */
export interface TcWorld { a: number; b: number; c: number; d: number; worldX: number; worldY: number }
/** A bone's local transform, Spine's fields. */
export interface TcLocal { x: number; y: number; rotation: number; scaleX: number; scaleY: number; shearX: number; shearY: number }

export interface TcTo { to: TcChannel; offset: number; max: number; scale: number }
export interface TcFrom { from: TcChannel; offset: number; to: TcTo[] }

/** What the solve reads off a constraint. */
export interface TcSolve {
  localSource: boolean;
  localTarget: boolean;
  additive: boolean;
  clamp: boolean;
  offsets: Record<TcChannel, number>;
  properties: readonly TcFrom[];
}

export type TcMix = Record<TcChannel, number>;

const atan2Deg = (y: number, x: number) => Math.atan2(y, x) * RAD_DEG;

/** `From*.value`: what the source gives for one property. */
export function tcSourceValue(from: TcChannel, local: boolean, sw: TcWorld, sl: TcLocal, offsets: Record<TcChannel, number>): number {
  switch (from) {
    case "rotate": {
      if (local) return sl.rotation + offsets.rotate;
      let v = Math.atan2(sw.c, sw.a) * RAD_DEG + (sw.a * sw.d - sw.b * sw.c > 0 ? offsets.rotate : -offsets.rotate);
      if (v < 0) v += 360;
      return v;
    }
    case "x": return local ? sl.x + offsets.x : offsets.x * sw.a + offsets.y * sw.b + sw.worldX;
    case "y": return local ? sl.y + offsets.y : offsets.x * sw.c + offsets.y * sw.d + sw.worldY;
    case "scaleX":
      return local ? sl.scaleX + offsets.scaleX : Math.sqrt(sw.a * sw.a + sw.c * sw.c) + offsets.scaleX;
    case "scaleY":
      return local ? sl.scaleY + offsets.scaleY : Math.sqrt(sw.b * sw.b + sw.d * sw.d) + offsets.scaleY;
    case "shearY":
      return local ? sl.shearY + offsets.shearY
        : (Math.atan2(sw.d, sw.b) - Math.atan2(sw.c, sw.a)) * RAD_DEG - 90 + offsets.shearY;
  }
}

/** `To*.mix`. */
const mixOf = (to: TcChannel, mix: TcMix) => mix[to];

/** `To*.apply` on a local transform (mutated). */
export function tcApplyLocal(to: TcChannel, mix: TcMix, b: TcLocal, value: number, additive: boolean): void {
  switch (to) {
    case "rotate": b.rotation += (additive ? value : value - b.rotation) * mix.rotate; break;
    case "x": b.x += (additive ? value : value - b.x) * mix.x; break;
    case "y": b.y += (additive ? value : value - b.y) * mix.y; break;
    case "scaleX":
      if (additive) b.scaleX *= 1 + (value - 1) * mix.scaleX;
      else if (b.scaleX !== 0) b.scaleX += (value - b.scaleX) * mix.scaleX;
      break;
    case "scaleY":
      if (additive) b.scaleY *= 1 + (value - 1) * mix.scaleY;
      else if (b.scaleY !== 0) b.scaleY += (value - b.scaleY) * mix.scaleY;
      break;
    case "shearY":
      b.shearY += (additive ? value : value - b.shearY) * mix.shearY;
      break;
  }
}

/** `To*.apply` on a world matrix (mutated). */
export function tcApplyWorld(to: TcChannel, mix: TcMix, b: TcWorld, value: number, additive: boolean): void {
  switch (to) {
    case "rotate": {
      const { a, b: bb, c, d } = b;
      value *= DEG_RAD;
      if (!additive) value -= Math.atan2(c, a);
      if (value > PI) value -= PI2;
      else if (value < -PI) value += PI2;
      value *= mix.rotate;
      const cos = Math.cos(value), sin = Math.sin(value);
      b.a = cos * a - sin * c;
      b.b = cos * bb - sin * d;
      b.c = sin * a + cos * c;
      b.d = sin * bb + cos * d;
      break;
    }
    case "x":
      if (!additive) value -= b.worldX;
      b.worldX += value * mix.x;
      break;
    case "y":
      if (!additive) value -= b.worldY;
      b.worldY += value * mix.y;
      break;
    case "scaleX": {
      if (additive) {
        const s = 1 + (value - 1) * mix.scaleX;
        b.a *= s;
        b.c *= s;
      } else {
        let s = Math.sqrt(b.a * b.a + b.c * b.c);
        if (s !== 0) {
          s = 1 + ((value - s) * mix.scaleX) / s;
          b.a *= s;
          b.c *= s;
        }
      }
      break;
    }
    case "scaleY": {
      if (additive) {
        const s = 1 + (value - 1) * mix.scaleY;
        b.b *= s;
        b.d *= s;
      } else {
        let s = Math.sqrt(b.b * b.b + b.d * b.d);
        if (s !== 0) {
          s = 1 + ((value - s) * mix.scaleY) / s;
          b.b *= s;
          b.d *= s;
        }
      }
      break;
    }
    case "shearY": {
      const by = Math.atan2(b.d, b.b);
      value = (value + 90) * DEG_RAD;
      if (additive) value -= PI / 2;
      else {
        value -= by - Math.atan2(b.c, b.a);
        if (value > PI) value -= PI2;
        else if (value < -PI) value += PI2;
      }
      value = by + value * mix.shearY;
      const s = Math.sqrt(b.b * b.b + b.d * b.d);
      b.b = Math.cos(value) * s;
      b.d = Math.sin(value) * s;
      break;
    }
  }
}

/** Every target property of one source value, as `TransformConstraint.update`
 *  applies them to one bone: offset, scale, clamp, then the property. */
function eachTarget(
  data: TcSolve, mix: TcMix, sw: TcWorld, sl: TcLocal, apply: (to: TcChannel, value: number) => void,
): void {
  for (const from of data.properties) {
    const value = tcSourceValue(from.from, data.localSource, sw, sl, data.offsets) - from.offset;
    for (const to of from.to) {
      if (mixOf(to.to, mix) === 0) continue;
      let v = to.offset + value * to.scale;
      if (data.clamp) {
        v = to.offset < to.max ? Math.min(to.max, Math.max(to.offset, v)) : Math.min(to.offset, Math.max(to.max, v));
      }
      apply(to.to, v);
    }
  }
}

/** Nothing to do when every mix is 0 (the runtime returns early). */
export function tcIdle(mix: TcMix): boolean {
  return TC_CHANNELS.every((c) => mix[c] === 0);
}

/** One bone's world matrix after the constraint, `localTarget` off. */
export function tcSolveWorld(data: TcSolve, mix: TcMix, sw: TcWorld, sl: TcLocal, target: TcWorld): TcWorld {
  const out = { ...target };
  eachTarget(data, mix, sw, sl, (to, v) => tcApplyWorld(to, mix, out, v, data.additive));
  return out;
}

/** One bone's local transform after the constraint, `localTarget` on. */
export function tcSolveLocal(data: TcSolve, mix: TcMix, sw: TcWorld, sl: TcLocal, target: TcLocal): TcLocal {
  const out = { ...target };
  eachTarget(data, mix, sw, sl, (to, v) => tcApplyLocal(to, mix, out, v, data.additive));
  return out;
}

/**
 * `BonePose.updateLocalTransform` for normal inherit: the local transform
 * that gives world `w` under parent world `p` (null: a root bone).
 */
export function tcLocalOf(w: TcWorld, p: TcWorld | null): TcLocal {
  if (!p) return { x: w.worldX, y: w.worldY, ...set5(w.a, w.b, w.c, w.d, 0) };
  const pa = p.a, pb = p.b, pc = p.c, pd = p.d;
  const pid = 1 / (pa * pd - pb * pc);
  const ia = pd * pid, ib = pb * pid, ic = pc * pid, id = pa * pid;
  const dx = w.worldX - p.worldX, dy = w.worldY - p.worldY;
  return {
    x: dx * ia - dy * ib,
    y: dy * id - dx * ic,
    ...set5(ia * w.a - ib * w.c, ia * w.b - ib * w.d, id * w.c - ic * w.a, id * w.d - ic * w.b, 0),
  };
}

/** `BonePose.set5`. */
function set5(ra: number, rb: number, rc: number, rd: number, ro: number): Omit<TcLocal, "x" | "y"> {
  const x = ra * ra + rc * rc, y = rb * rb + rd * rd;
  if (x > EPSILON2) {
    const r = atan2Deg(rc, ra);
    let scaleY = Math.sqrt(y), shearY = 0;
    if (y > EPSILON2) {
      shearY = atan2Deg(rd, rb);
      if (ra * rd - rb * rc < 0) { scaleY = -scaleY; shearY += 90 - r; } else shearY -= 90 + r;
      if (shearY > 180) shearY -= 360;
      else if (shearY <= -180) shearY += 360;
    }
    return { rotation: r + ro, scaleX: Math.sqrt(x), scaleY, shearX: 0, shearY };
  }
  return { rotation: y > EPSILON2 ? atan2Deg(rd, rb) - 90 + ro : ro, scaleX: 0, scaleY: Math.sqrt(y), shearX: 0, shearY: 0 };
}
