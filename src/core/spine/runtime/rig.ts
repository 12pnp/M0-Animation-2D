import { readPolyline } from "@/core/math/easing";
import {
  type AnimationData, type AttachmentData, type Channel, DEG_RAD, type Frame, type Interval, type MeshData,
  type RegionData, type RigData, type SequenceMode, type SkinData,
} from "./rigData";

/**
 * One posed instance of a `RigData`: the BoneBurst runtime's skeleton
 * (docs/PREVIEW-RUNTIME-PLAN.md). DOM-free, so the preview draws it and
 * vitest holds it to spine-core frame by frame (`tests/spineRuntime.test.ts`).
 *
 * Everything is y UP, as the format is; `yDown` gives the preview's (and the
 * editor's) y-down numbers.
 */
export class Rig {
  /** Per bone: x y rotation scaleX scaleY shearX shearY, the local pose. */
  readonly local: Float64Array;
  /** Per bone: a b c d worldX worldY, y up; (a, c) is the bone's x axis. */
  readonly world: Float64Array;
  /** Per bone: 1 when it is posed and its slots drawn. A skin-required bone
   *  is active only while a shown skin lists it or a bone under it. */
  readonly active: Uint8Array;
  /** Per slot: r g b a. */
  readonly color: Float32Array;
  /** Per slot: the attachment key shown, or null. */
  readonly attachment: Array<string | null>;
  /** Per slot: a mesh's deformed vertices (`Timeline` "deform"), or null for its setup ones. */
  readonly deform: Array<Float64Array | null>;
  /** Per slot: the sequence frame keyed, or -1 for the attachment's setup frame. */
  readonly sequenceIndex: Int32Array;
  /** Slot indices, back to front. */
  drawOrder: number[];
  /** The skins over the default one, in order: a later one wins a key. */
  private skins: SkinData[] = [];
  private defaultSkin: SkinData | null;

  constructor(readonly data: RigData) {
    this.local = new Float64Array(data.bones.length * 7);
    this.world = new Float64Array(data.bones.length * 6);
    this.active = new Uint8Array(data.bones.length);
    this.color = new Float32Array(data.slots.length * 4);
    this.attachment = data.slots.map(() => null);
    this.deform = data.slots.map(() => null);
    this.sequenceIndex = new Int32Array(data.slots.length).fill(-1);
    this.drawOrder = data.slots.map((s) => s.index);
    this.defaultSkin = data.skins.find((s) => s.name === "default") ?? null;
    this.setSkins([]);
    this.setupPose();
  }

  /** Show these skins over the default one, combined in order. Their bones
   *  become active, with every bone above them. */
  setSkins(names: readonly string[]): void {
    this.skins = names.map((n) => this.data.skins.find((s) => s.name === n)).filter((s): s is SkinData => !!s);
    for (const b of this.data.bones) this.active[b.index] = b.skinRequired ? 0 : 1;
    for (const skin of this.skins) {
      for (let bone = 0, i = 0; i < skin.bones.length; i++) {
        bone = skin.bones[i]!;
        while (bone >= 0) { this.active[bone] = 1; bone = this.data.bones[bone]!.parent; }
      }
    }
  }

  animation(name: string): AnimationData | undefined {
    return this.data.animations.find((a) => a.name === name);
  }

  setupPose(): void {
    for (const b of this.data.bones) {
      this.local.set([b.x, b.y, b.rotation, b.scaleX, b.scaleY, b.shearX, b.shearY], b.index * 7);
    }
    for (const s of this.data.slots) {
      this.color.set(s.color, s.index * 4);
      this.attachment[s.index] = s.attachment;
      this.deform[s.index] = null;
    }
    this.sequenceIndex.fill(-1);
    this.drawOrder = this.data.slots.map((s) => s.index);
  }

  /**
   * Pose `anim` at `time` seconds over the setup pose. A looping animation
   * wraps its time by its duration; a timeline before its first key leaves
   * the setup value. Deform and sequence keys apply only while the slot shows
   * the attachment they were keyed on (or a linked mesh playing its keys).
   */
  apply(anim: AnimationData, time: number, loop: boolean): void {
    if (loop && anim.duration > 0) time %= anim.duration;
    for (const t of anim.timelines) {
      switch (t.kind) {
        case "bone": {
          const v = sample(t.channel, time);
          if (v === null) break;
          const b = this.data.bones[t.bone]!;
          const at = t.bone * 7;
          switch (t.prop) {
            case "rotate": this.local[at + 2] = b.rotation + v; break;
            case "x": this.local[at] = b.x + v; break;
            case "y": this.local[at + 1] = b.y + v; break;
            case "scaleX": this.local[at + 3] = b.scaleX * v; break;
            case "scaleY": this.local[at + 4] = b.scaleY * v; break;
            case "shearX": this.local[at + 5] = b.shearX + v; break;
            case "shearY": this.local[at + 6] = b.shearY + v; break;
          }
          break;
        }
        case "color": {
          const v = sample(t.channel, time);
          if (v !== null) this.color[t.slot * 4 + t.index] = v;
          break;
        }
        case "attachment": {
          const i = keyAt(t.times, time);
          if (i >= 0) this.attachment[t.slot] = t.names[i]!;
          break;
        }
        case "drawOrder": {
          const i = keyAt(t.times, time);
          if (i >= 0) this.drawOrder = t.orders[i] ?? this.data.slots.map((s) => s.index);
          break;
        }
        case "deform": {
          if (this.attachmentOf(t.slot)?.timeline !== t.attachment) break;
          const i = keyAt(t.times, time);
          if (i < 0) break;
          const a = t.vertices[i]!;
          if (i === t.times.length - 1) { this.deform[t.slot] = a; break; }
          const p = percent(t.curves[i]!, t.times[i]!, t.times[i + 1]!, time);
          const b = t.vertices[i + 1]!;
          const out = new Float64Array(a.length);
          for (let k = 0; k < a.length; k++) out[k] = a[k]! + (b[k]! - a[k]!) * p;
          this.deform[t.slot] = out;
          break;
        }
        case "sequence": {
          const att = this.attachmentOf(t.slot);
          if (att?.timeline !== t.attachment || !att.sequence) break;
          const i = keyAt(t.times, time);
          if (i < 0) break;
          this.sequenceIndex[t.slot] = sequenceFrame(t.modes[i]!, t.indices[i]!, t.delays[i]!, time - t.times[i]!, att.sequence.count);
          break;
        }
      }
    }
  }

  /** World transforms, parents first (the file lists them so); inactive bones keep theirs. */
  updateWorld(): void {
    const L = this.local, W = this.world;
    for (const b of this.data.bones) {
      if (!this.active[b.index]) continue;
      const l = b.index * 7;
      const rx = (L[l + 2]! + L[l + 5]!) * DEG_RAD;
      const ry = (L[l + 2]! + 90 + L[l + 6]!) * DEG_RAD;
      const la = Math.cos(rx) * L[l + 3]!, lb = Math.cos(ry) * L[l + 4]!;
      const lc = Math.sin(rx) * L[l + 3]!, ld = Math.sin(ry) * L[l + 4]!;
      const x = L[l]!, y = L[l + 1]!;
      const w = b.index * 6;
      if (b.parent < 0) {
        W[w] = la; W[w + 1] = lb; W[w + 2] = lc; W[w + 3] = ld; W[w + 4] = x; W[w + 5] = y;
        continue;
      }
      const p = b.parent * 6;
      const pa = W[p]!, pb = W[p + 1]!, pc = W[p + 2]!, pd = W[p + 3]!;
      W[w] = pa * la + pb * lc;
      W[w + 1] = pa * lb + pb * ld;
      W[w + 2] = pc * la + pd * lc;
      W[w + 3] = pc * lb + pd * ld;
      W[w + 4] = pa * x + pb * y + W[p + 4]!;
      W[w + 5] = pc * x + pd * y + W[p + 5]!;
    }
  }

  /** The attachment slot `slot` shows: its key looked up in the skins over
   *  the default one, the last that has it winning. Null on an inactive bone. */
  attachmentOf(slot: number): AttachmentData | null {
    const key = this.attachment[slot];
    if (key === null || key === undefined || !this.active[this.data.slots[slot]!.bone]) return null;
    for (let i = this.skins.length - 1; i >= 0; i--) {
      const a = this.skins[i]!.attachments.get(slot)?.get(key);
      if (a) return a;
    }
    return this.defaultSkin?.attachments.get(slot)?.get(key) ?? null;
  }

  /** The image the attachment shows in this slot: its sequence frame, or its only one. */
  frameOf(slot: number, att: AttachmentData): Frame {
    if (!att.sequence) return att.frames[0]!;
    const keyed = this.sequenceIndex[slot]!;
    const i = keyed === -1 ? att.sequence.setup : keyed;
    return att.frames[Math.max(0, Math.min(att.frames.length - 1, i))]!;
  }

  /** A region's four corners in world space (y up), into `out`. */
  regionWorld(slot: number, region: RegionData, out: Float32Array | Float64Array): void {
    const w = this.data.slots[slot]!.bone * 6, W = this.world;
    const a = W[w]!, b = W[w + 1]!, c = W[w + 2]!, d = W[w + 3]!, x = W[w + 4]!, y = W[w + 5]!;
    const k = this.frameOf(slot, region).corners;
    for (let i = 0; i < 8; i += 2) {
      out[i] = a * k[i]! + b * k[i + 1]! + x;
      out[i + 1] = c * k[i]! + d * k[i + 1]! + y;
    }
  }

  /** A mesh's vertices in world space (y up), into `out` (2 per vertex):
   *  unweighted through the slot's bone, weighted as the weighted sum of each
   *  influence through its own bone. */
  meshWorld(slot: number, mesh: MeshData, out: Float32Array | Float64Array): void {
    const W = this.world, deform = this.deform[slot];
    const v = mesh.vertices;
    if (!mesh.weighted) {
      const src = deform ?? v;
      const w = this.data.slots[slot]!.bone * 6;
      const a = W[w]!, b = W[w + 1]!, c = W[w + 2]!, d = W[w + 3]!, x = W[w + 4]!, y = W[w + 5]!;
      for (let i = 0; i < mesh.vertexCount * 2; i += 2) {
        const lx = src[i]!, ly = src[i + 1]!;
        out[i] = a * lx + b * ly + x;
        out[i + 1] = c * lx + d * ly + y;
      }
      return;
    }
    let read = 0, f = 0;
    for (let i = 0; i < mesh.vertexCount * 2; i += 2) {
      let wx = 0, wy = 0;
      const n = v[read++]!;
      for (let j = 0; j < n; j++, read += 4, f += 2) {
        const w = v[read]! * 6;
        const lx = v[read + 1]! + (deform ? deform[f]! : 0), ly = v[read + 2]! + (deform ? deform[f + 1]! : 0);
        const weight = v[read + 3]!;
        wx += (W[w]! * lx + W[w + 1]! * ly + W[w + 4]!) * weight;
        wy += (W[w + 2]! * lx + W[w + 3]! * ly + W[w + 5]!) * weight;
      }
      out[i] = wx;
      out[i + 1] = wy;
    }
  }

  /** Bone `bone`'s world matrix with y down: [a, b, c, d, worldX, worldY]. */
  yDown(bone: number): number[] {
    const w = bone * 6, W = this.world;
    return [W[w]!, W[w + 1]!, -W[w + 2]!, -W[w + 3]!, W[w + 4]!, -W[w + 5]!];
  }
}

/** The last key at or before `time`, or -1 before the first. */
function keyAt(times: readonly number[], time: number): number {
  if (!times.length || time < times[0]!) return -1;
  let lo = 0, hi = times.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid]! <= time) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/** How far `time` is from one key (0) to the next (1), through the interval's curve. */
function percent(curve: Interval, t0: number, t1: number, time: number): number {
  if (curve === "stepped") return 0;
  if (curve) return readPolyline(curve, time);
  return (time - t0) / (t1 - t0);
}

/** The channel's value at `time`, or null before its first key. */
function sample(c: Channel, time: number): number | null {
  const i = keyAt(c.times, time);
  if (i < 0) return null;
  if (i === c.times.length - 1) return c.values[i]!;
  const curve = c.curves[i]!;
  if (curve === "stepped") return c.values[i]!;
  if (curve) return readPolyline(curve, time);
  return c.values[i]! + percent(null, c.times[i]!, c.times[i + 1]!, time) * (c.values[i + 1]! - c.values[i]!);
}

/**
 * The frame a sequence key shows `elapsed` seconds after it: `index` held, or
 * stepped on every `delay` seconds — once to the end, looping, or back and
 * forth — and the reverse modes the same counted from the last frame.
 */
export function sequenceFrame(mode: SequenceMode, index: number, delay: number, elapsed: number, count: number): number {
  if (mode === "hold" || delay <= 0) return Math.min(index, count - 1);
  // A count within 1e-5 of a frame short of a whole number rounds up, as the
  // runtime does (measured against spine-core at several delays).
  const i = index + Math.floor(elapsed / delay + 1e-5);
  const bounce = (k: number) => {
    const n = count * 2 - 2;
    if (n <= 0) return 0;
    k %= n;
    return k >= count ? n - k : k;
  };
  switch (mode) {
    case "once": return Math.min(i, count - 1);
    case "loop": return i % count;
    case "pingpong": return bounce(i);
    case "onceReverse": return Math.max(count - 1 - i, 0);
    case "loopReverse": return count - 1 - (i % count);
    case "pingpongReverse": return count - 1 - bounce(i);
  }
}
