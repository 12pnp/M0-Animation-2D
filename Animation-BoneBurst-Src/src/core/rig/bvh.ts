/**
 * BVH motion capture: the text format (a joint hierarchy, then one line of
 * channel values per frame) and forward kinematics to each joint's position.
 * Pure; `bvhClip.ts` turns the positions into a library clip.
 *
 * Each joint's local transform is its OFFSET plus any position channels, then
 * its rotation channels applied in the order the file lists them (the first
 * listed is outermost); an `End Site` is a point at its offset from its joint.
 */

export type Vec3 = [number, number, number];

export interface BvhJoint {
  name: string;
  parent: number;
  offset: Vec3;
  /** e.g. "Xposition", "Zrotation", in the file's order. */
  channels: string[];
  /** Where this joint's channels start in a frame's values. */
  start: number;
  /** The End Site's offset, when the joint has one. */
  end: Vec3 | null;
}

export interface Bvh {
  joints: BvhJoint[];
  frameTime: number;
  frames: number[][];
}

export function parseBvh(text: string): Bvh {
  const tokens = text.split(/\s+/).filter(Boolean);
  let i = 0;
  const next = () => {
    const t = tokens[i++];
    if (t === undefined) throw new Error("BVH ends early");
    return t;
  };
  const num = () => {
    const v = Number(next());
    if (!Number.isFinite(v)) throw new Error(`BVH: "${tokens[i - 1]}" is not a number`);
    return v;
  };
  const expect = (word: string) => {
    const t = next();
    if (t !== word) throw new Error(`BVH: "${word}" expected, "${t}" found`);
  };

  expect("HIERARCHY");
  const joints: BvhJoint[] = [];
  let channelCount = 0;
  const readJoint = (parent: number): void => {
    const name = next();
    expect("{");
    const joint: BvhJoint = { name, parent, offset: [0, 0, 0], channels: [], start: channelCount, end: null };
    const index = joints.push(joint) - 1;
    for (;;) {
      const t = next();
      if (t === "OFFSET") joint.offset = [num(), num(), num()];
      else if (t === "CHANNELS") {
        const n = num();
        for (let c = 0; c < n; c++) joint.channels.push(next());
        channelCount += n;
      } else if (t === "JOINT") readJoint(index);
      else if (t === "End") {
        expect("Site");
        expect("{");
        expect("OFFSET");
        joint.end = [num(), num(), num()];
        expect("}");
      } else if (t === "}") return;
      else throw new Error(`BVH: unexpected "${t}" in joint ${name}`);
    }
  };
  expect("ROOT");
  readJoint(-1);

  expect("MOTION");
  expect("Frames:");
  const count = num();
  expect("Frame");
  expect("Time:");
  const frameTime = num();
  const frames: number[][] = [];
  for (let f = 0; f < count; f++) {
    const values: number[] = [];
    for (let c = 0; c < channelCount; c++) values.push(num());
    frames.push(values);
  }
  return { joints, frameTime, frames };
}

/** A rigid transform: a 3×3 rotation (row-major) and a translation. */
interface Xf { r: number[]; t: Vec3 }

const mulR = (a: number[], b: number[]): number[] => {
  const o = new Array<number>(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  return o;
};
const apply = (x: Xf, p: Vec3): Vec3 => [
  x.r[0]! * p[0] + x.r[1]! * p[1] + x.r[2]! * p[2] + x.t[0],
  x.r[3]! * p[0] + x.r[4]! * p[1] + x.r[5]! * p[2] + x.t[1],
  x.r[6]! * p[0] + x.r[7]! * p[1] + x.r[8]! * p[2] + x.t[2],
];

function axisRotation(axis: string, degrees: number): number[] {
  const a = (degrees * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  if (axis === "X") return [1, 0, 0, 0, c, -s, 0, s, c];
  if (axis === "Y") return [c, 0, s, 0, 1, 0, -s, 0, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

export interface Positions {
  /** Each joint's position, by joint index. */
  joints: Vec3[];
  /** Each End Site's position, by its joint's index (null without one). */
  ends: Array<Vec3 | null>;
}

/** Every joint's position at frame `f` (or the rest pose, all channels 0, when `f` is null). */
export function positionsAt(bvh: Bvh, f: number | null): Positions {
  const values = f === null ? null : bvh.frames[f]!;
  const world: Xf[] = [];
  const joints: Vec3[] = [], ends: Array<Vec3 | null> = [];
  for (const j of bvh.joints) {
    let t: Vec3 = [...j.offset];
    let r = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    j.channels.forEach((ch, k) => {
      const v = values ? values[j.start + k]! : 0;
      const axis = ch[0]!.toUpperCase();
      if (ch.endsWith("position")) t = axis === "X" ? [t[0] + v, t[1], t[2]] : axis === "Y" ? [t[0], t[1] + v, t[2]] : [t[0], t[1], t[2] + v];
      else r = mulR(r, axisRotation(axis, v));
    });
    const parent = j.parent >= 0 ? world[j.parent]! : null;
    const x: Xf = parent ? { r: mulR(parent.r, r), t: apply(parent, t) } : { r, t };
    world.push(x);
    joints.push(x.t);
    ends.push(j.end ? apply(x, j.end) : null);
  }
  return { joints, ends };
}
