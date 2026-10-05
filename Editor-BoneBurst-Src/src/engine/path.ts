import { DEG_RAD, type PathConstraintData, type PathData } from "./rigTypes";
import type { Rig } from "./rig";

/**
 * Spine's path constraint on the engine's pose: bones placed along a path
 * attachment's bezier — by fixed distance or by percent, spaced by bone
 * length, fixed, percent or proportionally — and turned to its tangent or to
 * the next bone (chain), optionally scaled to reach it. Past either end of an
 * open path the line through the end continues. Its author knows spine-core
 * (docs/SPEC.md §6 ▸ Provenance): this follows it, constant-speed sampling
 * included (each curve measured in 10 segments by forward differencing).
 */

const PI = 180 * DEG_RAD;
const EPSILON = 0.00001;

export interface PathPose { position: number; spacing: number; mixRotate: number; mixX: number; mixY: number }

export function solvePath(rig: Rig, k: PathConstraintData, pose: PathPose): void {
  const path = rig.attachmentOf(k.slot);
  if (path?.kind !== "path") return;
  const { mixRotate, mixX, mixY } = pose;
  if (mixRotate === 0 && mixX === 0 && mixY === 0) return;
  const W = rig.world;
  const tangents = k.rotateMode === "tangent", scale = k.rotateMode === "chainScale";
  const boneCount = k.bones.length, spacesCount = tangents ? boneCount : boneCount + 1;
  const spaces = new Float64Array(spacesCount);
  const lengths = scale ? new Float64Array(boneCount) : new Float64Array(0);
  const spacing = pose.spacing;
  const boneLength = (i: number) => {
    const b = k.bones[i]!, w = b * 6, setup = rig.data.bones[b]!.length;
    const x = setup * W[w]!, y = setup * W[w + 2]!;
    return { setup, length: Math.sqrt(x * x + y * y) };
  };

  if (k.spacingMode === "percent") {
    if (scale) for (let i = 0; i < spacesCount - 1; i++) lengths[i] = boneLength(i).length;
    spaces.fill(spacing, 1);
  } else if (k.spacingMode === "proportional") {
    let sum = 0;
    for (let i = 0, n = spacesCount - 1; i < n;) {
      const { setup, length } = boneLength(i);
      if (setup < EPSILON) {
        if (scale) lengths[i] = 0;
        spaces[++i] = spacing;
      } else {
        if (scale) lengths[i] = length;
        spaces[++i] = length;
        sum += length;
      }
    }
    if (sum > 0) {
      sum = (spacesCount / sum) * spacing;
      for (let i = 1; i < spacesCount; i++) spaces[i] = spaces[i]! * sum;
    }
  } else {
    const lengthSpacing = k.spacingMode === "length";
    for (let i = 0, n = spacesCount - 1; i < n;) {
      const { setup, length } = boneLength(i);
      if (setup < EPSILON) {
        if (scale) lengths[i] = 0;
        spaces[++i] = spacing;
      } else {
        if (scale) lengths[i] = length;
        spaces[++i] = ((lengthSpacing ? Math.max(0, setup + spacing) : spacing) * length) / setup;
      }
    }
  }

  const positions = worldPositions(rig, k, path, pose.position, spaces, tangents);
  let boneX = positions[0]!, boneY = positions[1]!;
  let offsetRotation = k.offsetRotation;
  let tip: boolean;
  if (offsetRotation === 0) tip = k.rotateMode === "chain";
  else {
    tip = false;
    const sb = rig.data.slots[k.slot]!.bone * 6;
    offsetRotation *= W[sb]! * W[sb + 3]! - W[sb + 1]! * W[sb + 2]! > 0 ? DEG_RAD : -DEG_RAD;
  }
  for (let i = 0, p = 3; i < boneCount; i++, p += 3) {
    const bone = k.bones[i]!, w = bone * 6;
    W[w + 4] = W[w + 4]! + (boneX - W[w + 4]!) * mixX;
    W[w + 5] = W[w + 5]! + (boneY - W[w + 5]!) * mixY;
    const x = positions[p]!, y = positions[p + 1]!, dx = x - boneX, dy = y - boneY;
    if (scale) {
      const length = lengths[i]!;
      if (length !== 0) {
        const s = (Math.sqrt(dx * dx + dy * dy) / length - 1) * mixRotate + 1;
        W[w] = W[w]! * s;
        W[w + 2] = W[w + 2]! * s;
      }
    }
    boneX = x;
    boneY = y;
    if (mixRotate > 0) {
      const a = W[w]!, b = W[w + 1]!, c = W[w + 2]!, d = W[w + 3]!;
      let r: number;
      if (tangents) r = positions[p - 1]!;
      else if (spaces[i + 1] === 0) r = positions[p + 2]!;
      else r = Math.atan2(dy, dx);
      r -= Math.atan2(c, a);
      if (tip) {
        const cos = Math.cos(r), sin = Math.sin(r), length = rig.data.bones[bone]!.length;
        boneX += (length * (cos * a - sin * c) - dx) * mixRotate;
        boneY += (length * (sin * a + cos * c) - dy) * mixRotate;
      } else r += offsetRotation;
      if (r > PI) r -= 2 * PI;
      else if (r < -PI) r += 2 * PI;
      r *= mixRotate;
      const cos = Math.cos(r), sin = Math.sin(r);
      W[w] = cos * a - sin * c; W[w + 1] = cos * b - sin * d;
      W[w + 2] = sin * a + cos * c; W[w + 3] = sin * b + cos * d;
    }
  }
  for (const bone of k.bones) rig.worldChanged(bone);
}

/** Where each space along the path lands: x, y and the tangent's angle per space. */
function worldPositions(rig: Rig, k: PathConstraintData, path: PathData, start: number, spaces: Float64Array, tangents: boolean): Float64Array {
  const spacesCount = spaces.length;
  const out = new Float64Array(spacesCount * 3 + 2);
  const closed = path.closed;
  let verticesLength = path.vertexCount * 2, curveCount = verticesLength / 6, prevCurve = -1;
  let position = start;
  const vertices = (from: number, count: number, into: Float64Array, offset: number) => rig.vertexWorld(k.slot, path, from, count, into, offset);

  if (!path.constantSpeed) {
    const lengths = path.lengths;
    curveCount -= closed ? 1 : 2;
    const pathLength = lengths[curveCount]!;
    if (k.positionMode === "percent") position *= pathLength;
    const multiplier = k.spacingMode === "percent" ? pathLength : k.spacingMode === "proportional" ? pathLength / spacesCount : 1;
    const world = new Float64Array(8);
    for (let i = 0, o = 0, curve = 0; i < spacesCount; i++, o += 3) {
      const space = spaces[i]! * multiplier;
      position += space;
      let p = position;
      if (closed) {
        p %= pathLength;
        if (p < 0) p += pathLength;
        curve = 0;
      } else if (p < 0) {
        if (prevCurve !== -2) { prevCurve = -2; vertices(2, 4, world, 0); }
        before(p, world, 0, out, o);
        continue;
      } else if (p > pathLength) {
        if (prevCurve !== -3) { prevCurve = -3; vertices(verticesLength - 6, 4, world, 0); }
        after(p - pathLength, world, 0, out, o);
        continue;
      }
      for (;; curve++) {
        const length = lengths[curve]!;
        if (p > length) continue;
        if (curve === 0) p /= length;
        else {
          const prev = lengths[curve - 1]!;
          p = (p - prev) / (length - prev);
        }
        break;
      }
      if (curve !== prevCurve) {
        prevCurve = curve;
        if (closed && curve === curveCount) {
          vertices(verticesLength - 4, 4, world, 0);
          vertices(0, 4, world, 4);
        } else vertices(curve * 6 + 2, 8, world, 0);
      }
      curvePosition(p, world[0]!, world[1]!, world[2]!, world[3]!, world[4]!, world[5]!, world[6]!, world[7]!, out, o, tangents || (i > 0 && space === 0));
    }
    return out;
  }

  // Constant speed: the whole path in world space.
  let world: Float64Array;
  if (closed) {
    verticesLength += 2;
    world = new Float64Array(verticesLength);
    vertices(2, verticesLength - 4, world, 0);
    vertices(0, 2, world, verticesLength - 4);
    world[verticesLength - 2] = world[0]!;
    world[verticesLength - 1] = world[1]!;
  } else {
    curveCount--;
    verticesLength -= 4;
    world = new Float64Array(verticesLength);
    vertices(2, verticesLength, world, 0);
  }

  // Each curve's length, in 4 forward-difference steps.
  const curves = new Float64Array(curveCount);
  let pathLength = 0;
  let x1 = world[0]!, y1 = world[1]!, cx1 = 0, cy1 = 0, cx2 = 0, cy2 = 0, x2 = 0, y2 = 0;
  for (let i = 0, w = 2; i < curveCount; i++, w += 6) {
    cx1 = world[w]!; cy1 = world[w + 1]!; cx2 = world[w + 2]!; cy2 = world[w + 3]!; x2 = world[w + 4]!; y2 = world[w + 5]!;
    const tmpx = (x1 - cx1 * 2 + cx2) * 0.1875, tmpy = (y1 - cy1 * 2 + cy2) * 0.1875;
    const dddfx = ((cx1 - cx2) * 3 - x1 + x2) * 0.09375, dddfy = ((cy1 - cy2) * 3 - y1 + y2) * 0.09375;
    let ddfx = tmpx * 2 + dddfx, ddfy = tmpy * 2 + dddfy;
    let dfx = (cx1 - x1) * 0.75 + tmpx + dddfx * 0.16666667, dfy = (cy1 - y1) * 0.75 + tmpy + dddfy * 0.16666667;
    pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
    dfx += ddfx; dfy += ddfy; ddfx += dddfx; ddfy += dddfy;
    pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
    dfx += ddfx; dfy += ddfy;
    pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
    dfx += ddfx + dddfx; dfy += ddfy + dddfy;
    pathLength += Math.sqrt(dfx * dfx + dfy * dfy);
    curves[i] = pathLength;
    x1 = x2; y1 = y2;
  }

  if (k.positionMode === "percent") position *= pathLength;
  const multiplier = k.spacingMode === "percent" ? pathLength : k.spacingMode === "proportional" ? pathLength / spacesCount : 1;
  const segments = new Float64Array(10);
  let curveLength = 0;
  for (let i = 0, o = 0, curve = 0, segment = 0; i < spacesCount; i++, o += 3) {
    const space = spaces[i]! * multiplier;
    position += space;
    let p = position;
    if (closed) {
      p %= pathLength;
      if (p < 0) p += pathLength;
      curve = 0;
      segment = 0;
    } else if (p < 0) {
      before(p, world, 0, out, o);
      continue;
    } else if (p > pathLength) {
      after(p - pathLength, world, verticesLength - 4, out, o);
      continue;
    }
    for (;; curve++) {
      const length = curves[curve]!;
      if (p > length) continue;
      if (curve === 0) p /= length;
      else {
        const prev = curves[curve - 1]!;
        p = (p - prev) / (length - prev);
      }
      break;
    }
    // The curve's 10 segment lengths, when it is a new curve.
    if (curve !== prevCurve) {
      prevCurve = curve;
      let ii = curve * 6;
      x1 = world[ii]!; y1 = world[ii + 1]!; cx1 = world[ii + 2]!; cy1 = world[ii + 3]!;
      cx2 = world[ii + 4]!; cy2 = world[ii + 5]!; x2 = world[ii + 6]!; y2 = world[ii + 7]!;
      const tmpx = (x1 - cx1 * 2 + cx2) * 0.03, tmpy = (y1 - cy1 * 2 + cy2) * 0.03;
      const dddfx = ((cx1 - cx2) * 3 - x1 + x2) * 0.006, dddfy = ((cy1 - cy2) * 3 - y1 + y2) * 0.006;
      let ddfx = tmpx * 2 + dddfx, ddfy = tmpy * 2 + dddfy;
      let dfx = (cx1 - x1) * 0.3 + tmpx + dddfx * 0.16666667, dfy = (cy1 - y1) * 0.3 + tmpy + dddfy * 0.16666667;
      curveLength = Math.sqrt(dfx * dfx + dfy * dfy);
      segments[0] = curveLength;
      for (ii = 1; ii < 8; ii++) {
        dfx += ddfx; dfy += ddfy; ddfx += dddfx; ddfy += dddfy;
        curveLength += Math.sqrt(dfx * dfx + dfy * dfy);
        segments[ii] = curveLength;
      }
      dfx += ddfx; dfy += ddfy;
      curveLength += Math.sqrt(dfx * dfx + dfy * dfy);
      segments[8] = curveLength;
      dfx += ddfx + dddfx; dfy += ddfy + dddfy;
      curveLength += Math.sqrt(dfx * dfx + dfy * dfy);
      segments[9] = curveLength;
      segment = 0;
    }
    p *= curveLength;
    for (;; segment++) {
      const length = segments[segment]!;
      if (p > length) continue;
      if (segment === 0) p /= length;
      else {
        const prev = segments[segment - 1]!;
        p = segment + (p - prev) / (length - prev);
      }
      break;
    }
    curvePosition(p * 0.1, x1, y1, cx1, cy1, cx2, cy2, x2, y2, out, o, tangents || (i > 0 && space === 0));
  }
  return out;
}

/** Before an open path's start: along the line from its first point to its first handle. */
function before(p: number, temp: Float64Array, i: number, out: Float64Array, o: number): void {
  const x1 = temp[i]!, y1 = temp[i + 1]!, r = Math.atan2(temp[i + 3]! - y1, temp[i + 2]! - x1);
  out[o] = x1 + p * Math.cos(r);
  out[o + 1] = y1 + p * Math.sin(r);
  out[o + 2] = r;
}

/** Past an open path's end: along the line from its last handle through its last point. */
function after(p: number, temp: Float64Array, i: number, out: Float64Array, o: number): void {
  const x1 = temp[i + 2]!, y1 = temp[i + 3]!, r = Math.atan2(y1 - temp[i + 1]!, x1 - temp[i]!);
  out[o] = x1 + p * Math.cos(r);
  out[o + 1] = y1 + p * Math.sin(r);
  out[o + 2] = r;
}

function curvePosition(
  p: number, x1: number, y1: number, cx1: number, cy1: number, cx2: number, cy2: number, x2: number, y2: number,
  out: Float64Array, o: number, tangents: boolean,
): void {
  if (p === 0 || Number.isNaN(p)) {
    out[o] = x1;
    out[o + 1] = y1;
    out[o + 2] = Math.atan2(cy1 - y1, cx1 - x1);
    return;
  }
  const tt = p * p, ttt = tt * p, u = 1 - p, uu = u * u, uuu = uu * u;
  const ut = u * p, ut3 = ut * 3, uut3 = u * ut3, utt3 = ut3 * p;
  const x = x1 * uuu + cx1 * uut3 + cx2 * utt3 + x2 * ttt, y = y1 * uuu + cy1 * uut3 + cy2 * utt3 + y2 * ttt;
  out[o] = x;
  out[o + 1] = y;
  if (tangents) {
    if (p < 0.001) out[o + 2] = Math.atan2(cy1 - y1, cx1 - x1);
    else out[o + 2] = Math.atan2(y - (y1 * uu + cy1 * ut * 2 + cy2 * tt), x - (x1 * uu + cx1 * ut * 2 + cx2 * tt));
  }
}
