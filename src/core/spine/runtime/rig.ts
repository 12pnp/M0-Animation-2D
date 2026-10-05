import { readPolyline } from "@/core/math/easing";
import type { SpineInherit } from "../types";
import { type IkPose, solveIk } from "./ik";
import { solveTransform } from "./transform";
import { type PathPose, solvePath } from "./path";
import {
  type AnimationData, type AttachmentData, type Channel, DEG_RAD, type Frame, type Interval, type MeshData,
  type ClippingData, type PathData, type RegionData, type RigData, type SequenceMode, type SkinData, TRANSFORM_PROPS, type TransformMix,
} from "./rigData";

/**
 * One posed instance of a `RigData`: the BoneBurst runtime's skeleton
 * (docs/PREVIEW-RUNTIME-PLAN.md). DOM-free, so the preview draws it and
 * vitest holds it to spine-core frame by frame (`tests/spineRuntime.test.ts`).
 *
 * The format is y up; a skeleton `scaleY` of -1 poses it y down, as
 * spine-pixi's `Skeleton.yDown` does. It is not a flip of the y-up pose
 * afterwards: the inherit modes other than normal take the skeleton's scale
 * out of the parent and put it back.
 */
export class Rig {
  /** The skeleton's own placement, applied to the root bones. */
  x = 0;
  y = 0;
  scaleX = 1;
  scaleY = 1;
  /** Per bone: x y rotation scaleX scaleY shearX shearY, the local pose. */
  readonly local: Float64Array;
  /** Per bone: its inherit mode now (keys can change it). */
  readonly inherit: SpineInherit[];
  /** Per bone: a b c d worldX worldY, y up; (a, c) is the bone's x axis. */
  readonly world: Float64Array;
  /** Per bone: 1 when it is posed and its slots drawn. A skin-required bone
   *  is active only while a shown skin lists it or a bone under it. */
  readonly active: Uint8Array;
  /** Per slot: r g b a, then the dark colour's r g b (two-colour tint). */
  readonly color: Float32Array;
  /** Per slot: the attachment key shown, or null. */
  readonly attachment: Array<string | null>;
  /** Per slot: a mesh's deformed vertices (`Timeline` "deform"), or null for its setup ones. */
  readonly deform: Array<Float64Array | null>;
  /** Per slot: the sequence frame keyed, or -1 for the attachment's setup frame. */
  readonly sequenceIndex: Int32Array;
  /** Slot indices, back to front. */
  drawOrder: number[];
  /** Per constraint: 1 while it applies (its bones active, its skin shown when it needs one). */
  readonly constraintActive: Uint8Array;
  /** Per IK constraint (by index in `RigData.constraints`): its values now. */
  readonly ik: Array<IkPose | null>;
  /** Per transform constraint: its mixes now. */
  readonly transform: Array<TransformMix | null>;
  /** Per path constraint: its position, spacing and mixes now. */
  readonly path: Array<PathPose | null>;
  /** Per bone: its child bones. */
  private readonly children: number[][];
  /** Per bone: 1 while its world transform is out of date during `updateWorld`. */
  private readonly dirty: Uint8Array;
  /** The skins over the default one, in order: a later one wins a key. */
  private skins: SkinData[] = [];
  private defaultSkin: SkinData | null;

  constructor(readonly data: RigData) {
    this.children = data.bones.map(() => []);
    for (const b of data.bones) if (b.parent >= 0) this.children[b.parent]!.push(b.index);
    this.dirty = new Uint8Array(data.bones.length);
    this.constraintActive = new Uint8Array(data.constraints.length);
    this.ik = data.constraints.map((k) => (k.kind === "ik" ? { mix: 0, softness: 0, bendPositive: true, compress: false, stretch: false } : null));
    this.transform = data.constraints.map((k) => (k.kind === "transform" ? { ...k.mix } : null));
    this.path = data.constraints.map((k) => (k.kind === "path" ? { position: 0, spacing: 0, mixRotate: 0, mixX: 0, mixY: 0 } : null));
    this.local = new Float64Array(data.bones.length * 7);
    this.inherit = data.bones.map((b) => b.inherit);
    this.world = new Float64Array(data.bones.length * 6);
    this.active = new Uint8Array(data.bones.length);
    this.color = new Float32Array(data.slots.length * 7);
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
    const listed = new Set(this.skins.flatMap((s) => s.constraints));
    this.data.constraints.forEach((k, i) => {
      const bones = [k.kind === "ik" ? k.target : k.kind === "transform" ? k.source : this.data.slots[k.slot]!.bone, ...k.bones];
      this.constraintActive[i] = bones.every((b) => this.active[b]) && (!k.skinRequired || listed.has(i)) ? 1 : 0;
    });
  }

  animation(name: string): AnimationData | undefined {
    return this.data.animations.find((a) => a.name === name);
  }

  setupPose(): void {
    for (const b of this.data.bones) {
      this.local.set([b.x, b.y, b.rotation, b.scaleX, b.scaleY, b.shearX, b.shearY], b.index * 7);
      this.inherit[b.index] = b.inherit;
    }
    for (const s of this.data.slots) {
      this.color.set(s.color, s.index * 7);
      this.color.set(s.dark ?? [0, 0, 0], s.index * 7 + 4);
      this.attachment[s.index] = s.attachment;
      this.deform[s.index] = null;
    }
    this.sequenceIndex.fill(-1);
    this.drawOrder = this.data.slots.map((s) => s.index);
    this.data.constraints.forEach((k, i) => {
      if (k.kind === "ik") Object.assign(this.ik[i]!, { mix: k.mix, softness: k.softness, bendPositive: k.bendPositive, compress: k.compress, stretch: k.stretch });
      else if (k.kind === "transform") Object.assign(this.transform[i]!, k.mix);
      else Object.assign(this.path[i]!, { position: k.position, spacing: k.spacing, mixRotate: k.mixRotate, mixX: k.mixX, mixY: k.mixY });
    });
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
          if (v !== null) this.color[t.slot * 7 + t.index] = v;
          break;
        }
        case "ik": {
          const i = keyAt(t.times, time);
          if (i < 0) break;
          const pose = this.ik[t.constraint]!;
          pose.mix = sample(t.mix, time)!;
          pose.softness = sample(t.softness, time)!;
          pose.bendPositive = t.bendPositive[i]!;
          pose.compress = t.compress[i]!;
          pose.stretch = t.stretch[i]!;
          break;
        }
        case "pathPosition":
        case "pathSpacing": {
          const v = sample(t.channel, time);
          if (v !== null) this.path[t.constraint]![t.kind === "pathPosition" ? "position" : "spacing"] = v;
          break;
        }
        case "pathMix": {
          if (keyAt(t.times, time) < 0) break;
          const pose = this.path[t.constraint]!;
          pose.mixRotate = sample(t.rotate, time)!;
          pose.mixX = sample(t.x, time)!;
          pose.mixY = sample(t.y, time)!;
          break;
        }
        case "transform": {
          if (keyAt(t.times, time) < 0) break;
          const mix = this.transform[t.constraint]!;
          for (const p of TRANSFORM_PROPS) mix[p] = sample(t.mixes[p], time)!;
          break;
        }
        case "event": break;
        case "inherit": {
          const i = keyAt(t.times, time);
          if (i >= 0) this.inherit[t.bone] = t.modes[i]!;
          break;
        }
        case "attachment": {
          const i = keyAt(t.times, time);
          if (i >= 0) this.setAttachment(t.slot, t.names[i]!);
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

  /**
   * World transforms. The constraints apply in order, each once the bones
   * it reads are up to date; a bone a constraint moves leaves its
   * descendants out of date until something reads them, or the end. Bones
   * are posed parents first; inactive bones keep their last transform.
   */
  updateWorld(): void {
    for (const b of this.data.bones) this.dirty[b.index] = this.active[b.index]!;
    this.data.constraints.forEach((k, i) => {
      if (!this.constraintActive[i]) return;
      if (k.kind === "ik") {
        this.ensure(k.target);
        for (const b of k.bones) this.ensure(b);
        solveIk(this, k, this.ik[i]!);
      } else if (k.kind === "transform") {
        this.ensure(k.source);
        for (const b of k.bones) this.ensure(b);
        solveTransform(this, k, this.transform[i]!);
      } else {
        this.ensure(this.data.slots[k.slot]!.bone);
        const path = this.attachmentOf(k.slot);
        if (path?.kind === "path" && path.weighted) for (const b of weightedBones(path)) this.ensure(b);
        for (const b of k.bones) this.ensure(b);
        solvePath(this, k, this.path[i]!);
      }
    });
    for (const b of this.data.bones) this.ensure(b.index);
  }

  /** Bring a bone's world transform up to date, its ancestors first. */
  private ensure(bone: number): void {
    if (!this.dirty[bone]) return;
    const parent = this.data.bones[bone]!.parent;
    if (parent >= 0) this.ensure(parent);
    this.updateBone(bone);
    this.dirty[bone] = 0;
  }

  /** A constraint's result for a bone: its local pose for this frame, its
   *  world transform from it, and its descendants left to update. */
  setBone(bone: number, x: number, y: number, rotation: number, scaleX: number, scaleY: number, shearX: number, shearY: number): void {
    this.local.set([x, y, rotation, scaleX, scaleY, shearX, shearY], bone * 7);
    this.updateBone(bone);
    this.dirty[bone] = 0;
    this.stale(bone);
  }

  /** A constraint changed the bone's local pose: its world follows. */
  localChanged(bone: number): void {
    this.updateBone(bone);
    this.dirty[bone] = 0;
    this.stale(bone);
  }

  /**
   * A constraint set the bone's world transform directly. Its local pose is
   * derived from it now, while its parent is current, so anything that reads
   * the local pose later, or rebuilds the world under a changed parent, sees
   * the constrained result. A bone no constraint set keeps its applied local
   * values (a rotation of 270 stays 270, which matters to a partial mix).
   */
  worldChanged(bone: number): void {
    this.localFromWorld(bone);
    this.dirty[bone] = 0;
    this.stale(bone);
  }

  /** The local pose that gives the bone's world under its parent (normal
   *  inheritance), with no x shear. */
  private localFromWorld(bone: number): void {
    const W = this.world, w = bone * 6;
    const parent = this.data.bones[bone]!.parent, p = parent * 6;
    const pa = parent >= 0 ? W[p]! : this.scaleX, pb = parent >= 0 ? W[p + 1]! : 0;
    const pc = parent >= 0 ? W[p + 2]! : 0, pd = parent >= 0 ? W[p + 3]! : this.scaleY;
    const px = parent >= 0 ? W[p + 4]! : this.x, py = parent >= 0 ? W[p + 5]! : this.y;
    const pid = 1 / (pa * pd - pb * pc);
    const dx = W[w + 4]! - px, dy = W[w + 5]! - py;
    const ia = pid * pd, id = pid * pa, ib = pid * pb, ic = pid * pc;
    const a = W[w]!, b = W[w + 1]!, c = W[w + 2]!, d = W[w + 3]!;
    const ra = ia * a - ib * c, rb = ia * b - ib * d, rc = id * c - ic * a, rd = id * d - ic * b;
    const L = this.local, l = bone * 7;
    L[l] = dx * pd * pid - dy * pb * pid;
    L[l + 1] = dy * pa * pid - dx * pc * pid;
    L[l + 5] = 0;
    let scaleX = Math.sqrt(ra * ra + rc * rc);
    if (scaleX > 0.0001) {
      const det = ra * rd - rb * rc;
      // The y axis's length, signed by the mirror: shear turns it, it does not shorten it.
      L[l + 4] = Math.sign(det) * Math.sqrt(rb * rb + rd * rd);
      L[l + 6] = -Math.atan2(ra * rb + rc * rd, det) / DEG_RAD;
      L[l + 2] = Math.atan2(rc, ra) / DEG_RAD;
    } else {
      scaleX = 0;
      L[l + 4] = Math.sqrt(rb * rb + rd * rd);
      L[l + 6] = 0;
      L[l + 2] = 90 - Math.atan2(rd, rb) / DEG_RAD;
    }
    L[l + 3] = scaleX;
  }

  private stale(bone: number): void {
    for (const c of this.children[bone]!) {
      if (!this.active[c]) continue;
      this.dirty[c] = 1;
      this.stale(c);
    }
  }

  /**
   * One bone's world transform from its local pose and its parent's world.
   * A root takes the skeleton's placement. Below a parent, "normal" takes the
   * parent's whole matrix; the other modes take the parent's world position
   * but only part of its matrix, worked in the skeleton's unscaled space:
   *   onlyTranslation         none of it
   *   noRotationOrReflection  its scale (along its own x axis, and the area
   *                           ratio across), not its turn or a mirror
   *   noScale(OrReflection)   where it sends the bone's own rotation, as a
   *                           unit axis; the y axis a right angle on, mirrored
   *                           with the parent for noScale only
   */
  updateBone(index: number): void {
    const L = this.local, W = this.world;
    const l = index * 7, w = index * 6;
    const rotation = L[l + 2]!, shearX = L[l + 5]!, shearY = L[l + 6]!, scaleX = L[l + 3]!, scaleY = L[l + 4]!;
    const x = L[l]!, y = L[l + 1]!;
    const sx = this.scaleX, sy = this.scaleY;
    const parent = this.data.bones[index]!.parent;
    const local = (turn: number) => {
      const rx = (rotation + shearX - turn) * DEG_RAD, ry = (rotation + 90 + shearY - turn) * DEG_RAD;
      return [Math.cos(rx) * scaleX, Math.cos(ry) * scaleY, Math.sin(rx) * scaleX, Math.sin(ry) * scaleY] as const;
    };
    if (parent < 0) {
      const [la, lb, lc, ld] = local(0);
      W[w] = la * sx; W[w + 1] = lb * sx; W[w + 2] = lc * sy; W[w + 3] = ld * sy;
      W[w + 4] = x * sx + this.x; W[w + 5] = y * sy + this.y;
      return;
    }
    const p = parent * 6;
    let pa = W[p]!, pb = W[p + 1]!, pc = W[p + 2]!, pd = W[p + 3]!;
    W[w + 4] = pa * x + pb * y + W[p + 4]!;
    W[w + 5] = pc * x + pd * y + W[p + 5]!;
    const mode = this.inherit[index]!;
    if (mode === "normal") {
      const [la, lb, lc, ld] = local(0);
      W[w] = pa * la + pb * lc; W[w + 1] = pa * lb + pb * ld;
      W[w + 2] = pc * la + pd * lc; W[w + 3] = pc * lb + pd * ld;
      return;
    }
    // The parent without the skeleton's scale; put back at the end.
    pa /= sx; pb /= sx; pc /= sy; pd /= sy;
    let a: number, b: number, c: number, d: number;
    if (mode === "onlyTranslation") {
      [a, b, c, d] = local(0);
    } else if (mode === "noRotationOrReflection") {
      const r2 = pa * pa + pc * pc;
      let ma: number, mb: number, mc: number, md: number, turn: number;
      if (r2 > 1e-4) {
        // The parent as a turn by `turn` of diag(r, |det| / r).
        const k = Math.abs(pa * pd - pb * pc) / r2;
        ma = pa; mb = -pc * k; mc = pc; md = pa * k;
        turn = Math.atan2(pc, pa) / DEG_RAD;
      } else {
        ma = 0; mb = -pb; mc = 0; md = pd;
        turn = 90 - Math.atan2(pd, pb) / DEG_RAD;
      }
      const [la, lb, lc, ld] = local(turn);
      a = ma * la + mb * lc; b = ma * lb + mb * ld;
      c = mc * la + md * lc; d = mc * lb + md * ld;
    } else {
      const r = rotation * DEG_RAD, cos = Math.cos(r), sin = Math.sin(r);
      let za = pa * cos + pb * sin, zc = pc * cos + pd * sin;
      let len = Math.sqrt(za * za + zc * zc);
      if (len > 1e-5) { za /= len; zc /= len; }
      len = Math.sqrt(za * za + zc * zc);
      if (mode === "noScale" && pa * pd - pb * pc < 0) len = -len;
      const ry = 90 * DEG_RAD + Math.atan2(zc, za);
      const zb = Math.cos(ry) * len, zd = Math.sin(ry) * len;
      const la = Math.cos(shearX * DEG_RAD) * scaleX, lb = Math.cos((90 + shearY) * DEG_RAD) * scaleY;
      const lc = Math.sin(shearX * DEG_RAD) * scaleX, ld = Math.sin((90 + shearY) * DEG_RAD) * scaleY;
      a = za * la + zb * lc; b = za * lb + zb * ld;
      c = zc * la + zd * lc; d = zc * lb + zd * ld;
    }
    W[w] = a * sx; W[w + 1] = b * sx; W[w + 2] = c * sy; W[w + 3] = d * sy;
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

  /** A mesh's vertices in world space (y up), into `out` (2 per vertex). */
  meshWorld(slot: number, mesh: MeshData, out: Float32Array | Float64Array): void {
    this.vertexWorld(slot, mesh, 0, mesh.vertexCount * 2, out, 0);
  }

  /**
   * Vertices `start / 2` on, `count / 2` of them, of a mesh or path in world
   * space (y up), into `out` from `offset`: unweighted through the slot's
   * bone, weighted as the weighted sum of each influence through its own
   * bone; the slot's deform keys added in either case.
   */
  vertexWorld(slot: number, att: MeshData | PathData | ClippingData, start: number, count: number, out: Float32Array | Float64Array, offset: number): void {
    const W = this.world, deform = this.timelineDeform(slot, att);
    const v = att.vertices;
    if (!att.weighted) {
      const src = deform ?? v;
      const w = this.data.slots[slot]!.bone * 6;
      const a = W[w]!, b = W[w + 1]!, c = W[w + 2]!, d = W[w + 3]!, x = W[w + 4]!, y = W[w + 5]!;
      for (let i = start, o = offset; i < start + count; i += 2, o += 2) {
        const lx = src[i]!, ly = src[i + 1]!;
        out[o] = a * lx + b * ly + x;
        out[o + 1] = c * lx + d * ly + y;
      }
      return;
    }
    // Skip to vertex `start / 2` in the stream and in the deform offsets.
    let read = 0, f = 0;
    for (let i = 0; i < start; i += 2) { const n = v[read]!; read += 1 + n * 4; f += n * 2; }
    for (let o = offset, i = start; i < start + count; i += 2, o += 2) {
      let wx = 0, wy = 0;
      const n = v[read++]!;
      for (let j = 0; j < n; j++, read += 4, f += 2) {
        const w = v[read]! * 6;
        const lx = v[read + 1]! + (deform ? deform[f]! : 0), ly = v[read + 2]! + (deform ? deform[f + 1]! : 0);
        const weight = v[read + 3]!;
        wx += (W[w]! * lx + W[w + 1]! * ly + W[w + 4]!) * weight;
        wy += (W[w + 2]! * lx + W[w + 3]! * ly + W[w + 5]!) * weight;
      }
      out[o] = wx;
      out[o + 1] = wy;
    }
  }

  /** The slot's deformed vertices: they belong to what it shows (`setAttachment`). */
  private timelineDeform(slot: number, _att: MeshData | PathData | ClippingData): Float64Array | null {
    return this.deform[slot] ?? null;
  }

  /** Show `key` in the slot. A change restarts its sequence, and drops its
   *  deform unless the new attachment plays the same deform keys. */
  private setAttachment(slot: number, key: string | null): void {
    if (this.attachment[slot] === key) return;
    const before = this.attachmentOf(slot);
    this.attachment[slot] = key;
    const after = this.attachmentOf(slot);
    if (before === after) return;
    if (!before || !after || before.kind === "region" || after.kind === "region" || before.timeline !== after.timeline) this.deform[slot] = null;
    this.sequenceIndex[slot] = -1;
  }

  /** Bone `bone`'s world matrix: [a, b, c, d, worldX, worldY]. */
  matrix(bone: number): number[] {
    return Array.from(this.world.subarray(bone * 6, bone * 6 + 6));
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

/** The bones a weighted vertex stream reads. */
function weightedBones(att: MeshData | PathData): Set<number> {
  const out = new Set<number>();
  const v = att.vertices;
  for (let i = 0; i < v.length;) {
    const n = v[i++]!;
    for (let j = 0; j < n; j++, i += 4) out.add(v[i]!);
  }
  return out;
}
