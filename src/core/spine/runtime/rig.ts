import { readPolyline } from "@/core/math/easing";
import type { SpineInherit } from "../types";
import { type Bones, localFromWorld, normalWorld } from "./bones";
import { type IkPose, solveIk } from "./ik";
import { solveTransform } from "./transform";
import { type PathPose, solvePath } from "./path";
import { type SliderPose, solveSlider } from "./slider";
import { type PhysicsMode, type PhysicsPose, type PhysicsState, physicsState, resetPhysics, solvePhysics } from "./physics";
import {
  type AnimationData, type AttachmentData, type Channel, DEG_RAD, type Frame, type Interval, type MeshData,
  type BoxData, type ClippingData, type PathData, type PointData, type RegionData, type RigData, type SequenceMode, type SkinData, type Timeline, TRANSFORM_PROPS, type TransformMix,
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
export class Rig implements Bones {
  /** The skeleton's own placement, applied to the root bones. */
  x = 0;
  y = 0;
  scaleX = 1;
  scaleY = 1;
  /** The skeleton's clock, which physics steps by (`update`). */
  time = 0;
  /** Which way wind and gravity act (spine-core's skeleton defaults). */
  windX = 1;
  windY = 0;
  gravityX = 0;
  gravityY = 1;
  /** The animation time the last pose was at, for reset keys (`Track`). */
  applyLast = -1;
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
  readonly color: Float64Array;
  /** Per slot: the attachment key shown, or null. */
  readonly attachment: Array<string | null>;
  /** Per slot: a mesh's deformed vertices (`Timeline` "deform"), or null for its setup ones. */
  readonly deform: Array<Float64Array | null>;
  /** Per slot: the sequence frame keyed, or -1 for the attachment's setup frame. */
  readonly sequenceIndex: Int32Array;
  /** Slot indices, back to front. */
  drawOrder: number[];
  /** Per slot during a pose: 2 when a playing animation set its attachment,
   *  1 when only one mixing out did (`applyAttachment`). */
  private readonly attachmentMark: Uint8Array;
  /** Per constraint: 1 while it applies (its bones active, its skin shown when it needs one). */
  readonly constraintActive: Uint8Array;
  /** Per IK constraint (by index in `RigData.constraints`): its values now. */
  readonly ik: Array<IkPose | null>;
  /** Per transform constraint: its mixes now. */
  readonly transform: Array<TransformMix | null>;
  /** Per path constraint: its position, spacing and mixes now. */
  readonly path: Array<PathPose | null>;
  /** Per slider: its time and mix now. */
  readonly slider: Array<SliderPose | null>;
  /** Per physics constraint: its values now, and its simulation. */
  readonly physics: Array<PhysicsPose | null>;
  readonly physicsState: Array<PhysicsState | null>;
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
    this.slider = data.constraints.map((k) => (k.kind === "slider" ? { time: k.time, mix: k.mix } : null));
    this.physics = data.constraints.map((k) => (k.kind === "physics" ? physicsSetup(k) : null));
    this.physicsState = data.constraints.map((k) => (k.kind === "physics" ? physicsState() : null));
    this.local = new Float64Array(data.bones.length * 7);
    this.inherit = data.bones.map((b) => b.inherit);
    this.world = new Float64Array(data.bones.length * 6);
    this.active = new Uint8Array(data.bones.length);
    this.color = new Float64Array(data.slots.length * 7);
    this.attachment = data.slots.map(() => null);
    this.deform = data.slots.map(() => null);
    this.sequenceIndex = new Int32Array(data.slots.length).fill(-1);
    this.attachmentMark = new Uint8Array(data.slots.length);
    this.drawOrder = data.slots.map((s) => s.index);
    this.defaultSkin = data.skins.find((s) => s.name === "default") ?? null;
    this.setSkins([]);
    this.setupPose();
  }

  /** Move the skeleton's clock on, as spine-core's `Skeleton.update`. */
  update(dt: number): void { this.time += dt; }

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
      const bones = k.kind === "slider" ? (k.bone >= 0 ? [k.bone] : []) : k.kind === "physics" ? [k.bone]
        : [k.kind === "ik" ? k.target : k.kind === "transform" ? k.source : this.data.slots[k.slot]!.bone, ...k.bones];
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
    this.attachmentMark.fill(0);
    this.drawOrder = this.data.slots.map((s) => s.index);
    this.data.constraints.forEach((k, i) => {
      if (k.kind === "ik") Object.assign(this.ik[i]!, { mix: k.mix, softness: k.softness, bendPositive: k.bendPositive, compress: k.compress, stretch: k.stretch });
      else if (k.kind === "transform") Object.assign(this.transform[i]!, k.mix);
      else if (k.kind === "path") Object.assign(this.path[i]!, { position: k.position, spacing: k.spacing, mixRotate: k.mixRotate, mixX: k.mixX, mixY: k.mixY });
      else if (k.kind === "slider") Object.assign(this.slider[i]!, { time: k.time, mix: k.mix });
      else Object.assign(this.physics[i]!, physicsSetup(k));
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
      if (t.kind === "attachment") this.applyAttachment(t, time, "setup", true);
      else this.applyTimeline(t, time, 1, "setup", false);
    }
  }

  /**
   * One timeline at `time`, mixed in by `alpha` (spine-core's `Timeline.apply`).
   * `blend` says what it mixes from: the setup pose ("setup"), the current
   * value ("replace"; "first" the same, except before the first key, where it
   * fades the value back toward the setup pose), or it adds its change
   * ("add"). `out` is true while its animation mixes out of a crossfade:
   * draw order, inherit mode and sequence frame then only reset to the setup
   * pose, scale keeps the setup's sign, and IK keeps the setup's bend.
   */
  applyTimeline(t: Timeline, time: number, alpha: number, blend: Blend, out: boolean): void {
    switch (t.kind) {
      case "bone": {
        const b = this.data.bones[t.bone]!, L = this.local;
        const at = t.bone * 7 + PROP_OFFSET[t.prop];
        const setup = b[PROP_FIELD[t.prop]], current = L[at]!;
        if (time < t.channel.times[0]!) {
          if (blend === "setup") L[at] = setup;
          else if (blend === "first") L[at] = current + (setup - current) * alpha;
          break;
        }
        const v = sample(t.channel, time)!;
        if (t.prop === "scaleX" || t.prop === "scaleY") L[at] = scaleValue(v * setup, alpha, blend, out, current, setup);
        else if (blend === "setup") L[at] = setup + v * alpha;
        else if (blend === "add") L[at] = current + v * alpha;
        else L[at] = current + (v + setup - current) * alpha;
        break;
      }
      case "color": {
        const at = t.slot * 7 + t.index, c = this.color;
        const s = this.data.slots[t.slot]!;
        const setup = t.index < 4 ? s.color[t.index]! : (s.dark ?? [0, 0, 0])[t.index - 4]!;
        if (time < t.channel.times[0]!) {
          if (blend === "setup") c[at] = setup;
          else if (blend === "first") c[at] = c[at]! + (setup - c[at]!) * alpha;
          break;
        }
        const v = sample(t.channel, time)!;
        if (alpha === 1) c[at] = v;
        else {
          const base = blend === "setup" ? setup : c[at]!;
          c[at] = base + (v - base) * alpha;
        }
        break;
      }
      case "ik": {
        const k = this.data.constraints[t.constraint]!;
        if (k.kind !== "ik") break;
        const pose = this.ik[t.constraint]!;
        const i = keyAt(t.times, time);
        if (i < 0) {
          if (blend === "setup") Object.assign(pose, { mix: k.mix, softness: k.softness, bendPositive: k.bendPositive, compress: k.compress, stretch: k.stretch });
          else if (blend === "first") {
            pose.mix += (k.mix - pose.mix) * alpha;
            pose.softness += (k.softness - pose.softness) * alpha;
            Object.assign(pose, { bendPositive: k.bendPositive, compress: k.compress, stretch: k.stretch });
          }
          break;
        }
        const mix = sample(t.mix, time)!, softness = sample(t.softness, time)!;
        if (blend === "setup") {
          pose.mix = k.mix + (mix - k.mix) * alpha;
          pose.softness = k.softness + (softness - k.softness) * alpha;
          if (out) Object.assign(pose, { bendPositive: k.bendPositive, compress: k.compress, stretch: k.stretch });
          else Object.assign(pose, { bendPositive: t.bendPositive[i], compress: t.compress[i], stretch: t.stretch[i] });
        } else {
          pose.mix += (mix - pose.mix) * alpha;
          pose.softness += (softness - pose.softness) * alpha;
          if (!out) Object.assign(pose, { bendPositive: t.bendPositive[i], compress: t.compress[i], stretch: t.stretch[i] });
        }
        break;
      }
      case "transform": {
        const k = this.data.constraints[t.constraint]!;
        if (k.kind !== "transform") break;
        const mix = this.transform[t.constraint]!;
        const before = time < t.times[0]!;
        for (const p of TRANSFORM_PROPS) {
          mix[p] = absoluteValue(before ? null : sample(t.mixes[p], time)!, alpha, blend, mix[p], k.mix[p]);
        }
        break;
      }
      case "pathPosition":
      case "pathSpacing": {
        const k = this.data.constraints[t.constraint]!;
        if (k.kind !== "path") break;
        const pose = this.path[t.constraint]!, field = t.kind === "pathPosition" ? "position" : "spacing";
        pose[field] = absoluteValue(time < t.times[0]! ? null : sample(t.channel, time)!, alpha, blend, pose[field], k[field]);
        break;
      }
      case "physics": {
        const one = (i: number) => {
          const k = this.data.constraints[i]!;
          if (k.kind !== "physics" || !this.constraintActive[i]) return;
          const pose = this.physics[i]!, value = time < t.times[0]! ? null : sample(t.channel, time)!;
          // Mass mixes as mass, and the pose keeps its inverse (measured).
          if (t.prop === "mass") pose.massInverse = 1 / absoluteValue(value, alpha, blend, 1 / pose.massInverse, 1 / k.massInverse);
          else pose[t.prop] = absoluteValue(value, alpha, blend, pose[t.prop], k[t.prop]);
        };
        if (t.constraint >= 0) one(t.constraint);
        else this.data.constraints.forEach((k, i) => { if (k.kind === "physics" && k.global[t.prop]) one(i); });
        break;
      }
      case "physicsReset": {
        // A key passed since the last pose starts the simulation over.
        const last = this.applyLast;
        const passed = last > time
          ? t.times.some((at) => at > last || at <= time)
          : t.times.some((at) => at > last && at <= time);
        if (!passed || out) break;
        this.data.constraints.forEach((k, i) => {
          if (k.kind === "physics" && (t.constraint < 0 || t.constraint === i)) resetPhysics(this.physicsState[i]!, this.time);
        });
        break;
      }
      case "sliderTime":
      case "sliderMix": {
        const k = this.data.constraints[t.constraint]!;
        if (k.kind !== "slider") break;
        const pose = this.slider[t.constraint]!, field = t.kind === "sliderTime" ? "time" : "mix";
        pose[field] = absoluteValue(time < t.times[0]! ? null : sample(t.channel, time)!, alpha, blend, pose[field], k[field]);
        break;
      }
      case "pathMix": {
        const k = this.data.constraints[t.constraint]!;
        if (k.kind !== "path") break;
        const pose = this.path[t.constraint]!, before = time < t.times[0]!;
        pose.mixRotate = absoluteValue(before ? null : sample(t.rotate, time)!, alpha, blend, pose.mixRotate, k.mixRotate);
        pose.mixX = absoluteValue(before ? null : sample(t.x, time)!, alpha, blend, pose.mixX, k.mixX);
        pose.mixY = absoluteValue(before ? null : sample(t.y, time)!, alpha, blend, pose.mixY, k.mixY);
        break;
      }
      case "event": break;
      case "attachment": break;
      case "inherit": {
        const setup = this.data.bones[t.bone]!.inherit;
        if (out) { if (blend === "setup") this.inherit[t.bone] = setup; break; }
        const i = keyAt(t.times, time);
        if (i < 0) { if (blend === "setup" || blend === "first") this.inherit[t.bone] = setup; }
        else this.inherit[t.bone] = t.modes[i]!;
        break;
      }
      case "drawOrder": {
        const setup = () => this.data.slots.map((s) => s.index);
        if (out) { if (blend === "setup") this.drawOrder = setup(); break; }
        const i = keyAt(t.times, time);
        if (i < 0) { if (blend === "setup" || blend === "first") this.drawOrder = setup(); }
        else this.drawOrder = t.orders[i] ?? setup();
        break;
      }
      case "deform": this.applyDeform(t, time, alpha, blend); break;
      case "sequence": {
        if (out) { if (blend === "setup") this.sequenceIndex[t.slot] = -1; break; }
        const att = this.attachmentOf(t.slot);
        if (!att || att.timeline !== t.attachment || !att.sequence) break;
        const i = keyAt(t.times, time);
        if (i < 0) { if (blend === "setup" || blend === "first") this.sequenceIndex[t.slot] = -1; break; }
        this.sequenceIndex[t.slot] = sequenceFrame(t.modes[i]!, t.indices[i]!, t.delays[i]!, time - t.times[i]!, att.sequence.count);
        break;
      }
    }
  }

  /** A deform timeline mixed in by `alpha`. Its vertices are positions for an
   *  unweighted mesh (the setup ones when it has none) and offsets for a
   *  weighted one (none: zero). */
  private applyDeform(t: Extract<Timeline, { kind: "deform" }>, time: number, alpha: number, blend: Blend): void {
    const att = this.attachmentOf(t.slot);
    if (!att || att.kind === "region" || att.kind === "point" || att.timeline !== t.attachment) return;
    let d = this.deform[t.slot];
    if (!d) blend = "setup";
    const n = t.vertices[0]!.length, setup = att.weighted ? null : att.vertices;
    if (time < t.times[0]!) {
      if (blend === "setup" || (blend === "first" && alpha === 1)) { this.deform[t.slot] = null; return; }
      if (blend !== "first") return;
      d = this.deform[t.slot] = Float64Array.from(d!);
      for (let i = 0; i < n; i++) d[i] = setup ? d[i]! + (setup[i]! - d[i]!) * alpha : d[i]! * (1 - alpha);
      return;
    }
    const i = keyAt(t.times, time);
    let target = t.vertices[i]!;
    if (i < t.times.length - 1) {
      const p = percent(t.curves[i]!, t.times[i]!, t.times[i + 1]!, time), next = t.vertices[i + 1]!;
      target = target.map((v: number, k: number) => v + (next[k]! - v) * p);
    }
    const out = d && d.length === n ? Float64Array.from(d) : new Float64Array(n);
    for (let k = 0; k < n; k++) {
      const v = target[k]!, base = setup ? setup[k]! : 0;
      if (alpha === 1) out[k] = blend === "add" ? out[k]! + v - base : v;
      else if (blend === "setup") out[k] = setup ? base + (v - base) * alpha : v * alpha;
      else if (blend === "add") out[k] = out[k]! + (v - base) * alpha;
      else out[k] = out[k]! + (v - out[k]!) * alpha;
    }
    this.deform[t.slot] = out;
  }

  /**
   * An attachment timeline at `time` (spine-core's `applyAttachmentTimeline`).
   * Before its first key it resets to the setup attachment only from the
   * setup pose. An animation mixing out of a crossfade sets attachments too,
   * so its deform keys find theirs, but without `attachments` they go back
   * to the setup pose at the end of the pose unless another timeline sets
   * them (`settleAttachments`).
   */
  applyAttachment(t: Extract<Timeline, { kind: "attachment" }>, time: number, blend: Blend, attachments: boolean): void {
    if (!this.active[this.data.slots[t.slot]!.bone]) return;
    const i = keyAt(t.times, time);
    if (i < 0) { if (blend === "setup" || blend === "first") this.setAttachment(t.slot, this.data.slots[t.slot]!.attachment); }
    else this.setAttachment(t.slot, t.names[i]!);
    if (attachments) this.attachmentMark[t.slot] = 2;
    else if (this.attachmentMark[t.slot]! < 1) this.attachmentMark[t.slot] = 1;
  }

  /** Slots an outgoing animation alone set go back to their setup attachment. */
  settleAttachments(): void {
    this.attachmentMark.forEach((m, slot) => { if (m === 1) this.setAttachment(slot, this.data.slots[slot]!.attachment); });
    this.attachmentMark.fill(0);
  }

  /**
   * A rotate timeline mixed in by `alpha` < 1 (spine-core's
   * `applyRotateTimeline`): the bone turns the short way toward the key, and
   * keeps turning the way it started when the short way flips across a half
   * turn during the mix. `memory[at]` and `memory[at + 1]` keep the total
   * turn and the last difference between frames; `first` starts them.
   */
  applyRotate(t: Extract<Timeline, { kind: "bone" }>, time: number, alpha: number, blend: Blend, memory: Float64Array, at: number, first: boolean): void {
    if (first) memory[at] = 0;
    if (alpha === 1) { this.applyTimeline(t, time, 1, blend, false); return; }
    if (!this.active[t.bone]) return;
    const b = this.data.bones[t.bone]!, l = t.bone * 7 + 2, L = this.local;
    let r1: number, r2: number;
    if (time < t.channel.times[0]!) {
      if (blend === "setup") { L[l] = b.rotation; return; }
      if (blend !== "first") return;
      r1 = L[l]!;
      r2 = b.rotation;
    } else {
      r1 = blend === "setup" ? b.rotation : L[l]!;
      r2 = b.rotation + sample(t.channel, time)!;
    }
    let total: number, diff = r2 - r1;
    diff -= Math.ceil(diff / 360 - 0.5) * 360;
    if (diff === 0) total = memory[at]!;
    else {
      const lastTotal = first ? 0 : memory[at]!, lastDiff = first ? diff : memory[at + 1]!;
      const loops = lastTotal - (lastTotal % 360);
      total = diff + loops;
      const current = diff >= 0;
      let dir = lastTotal >= 0;
      if (Math.abs(lastDiff) <= 90 && Math.sign(lastDiff) !== Math.sign(diff)) {
        if (Math.abs(lastTotal - loops) > 180) {
          total += 360 * Math.sign(lastTotal);
          dir = current;
        } else if (loops !== 0) total -= 360 * Math.sign(lastTotal);
        else dir = current;
      }
      if (dir !== current) total += 360 * Math.sign(lastTotal);
      memory[at] = total;
    }
    memory[at + 1] = diff;
    L[l] = r1 + total * alpha;
  }

  /**
   * World transforms. The constraints apply in order, each once the bones
   * it reads are up to date; a bone a constraint moves leaves its
   * descendants out of date until something reads them, or the end. Bones
   * are posed parents first; inactive bones keep their last transform.
   */
  updateWorld(physics: PhysicsMode = "none"): void {
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
      } else if (k.kind === "physics") {
        this.ensure(k.bone);
        solvePhysics(this, k, this.physics[i]!, this.physicsState[i]!, physics);
      } else if (k.kind === "slider") {
        if (k.bone >= 0) this.ensure(k.bone);
        solveSlider(this, k, this.slider[i]!);
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

  /** A slider's animation changed the bone's local pose: it and what is
   *  under it rebuild when next read. */
  touched(bone: number): void {
    if (!this.active[bone]) return;
    this.dirty[bone] = 1;
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
    const W = this.world, parent = this.data.bones[bone]!.parent, p = parent * 6;
    if (parent >= 0) localFromWorld(W, bone * 6, W[p]!, W[p + 1]!, W[p + 2]!, W[p + 3]!, W[p + 4]!, W[p + 5]!, this.local, bone * 7);
    else localFromWorld(W, bone * 6, this.scaleX, 0, 0, this.scaleY, this.x, this.y, this.local, bone * 7);
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
      normalWorld(L, l, pa, pb, pc, pd, W[p + 4]!, W[p + 5]!, W, w);
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
      // The exact half turn here, not the eight-digit π (measured: the bone's
      // matrix is off by sin(shear x) × 2.3e-8 otherwise).
      const ry = Math.PI / 2 + Math.atan2(zc, za);
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
    return this.lookup(slot, key);
  }

  /** The attachment `key` names in the slot: the shown skins over the default one. */
  lookup(slot: number, key: string): AttachmentData | null {
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
  regionWorld(slot: number, region: RegionData, out: Writable): void {
    const w = this.data.slots[slot]!.bone * 6, W = this.world;
    const a = W[w]!, b = W[w + 1]!, c = W[w + 2]!, d = W[w + 3]!, x = W[w + 4]!, y = W[w + 5]!;
    const k = this.frameOf(slot, region).corners;
    for (let i = 0; i < 8; i += 2) {
      out[i] = a * k[i]! + b * k[i + 1]! + x;
      out[i + 1] = c * k[i]! + d * k[i + 1]! + y;
    }
  }

  /** A mesh's vertices in world space (y up), into `out` (2 per vertex). */
  meshWorld(slot: number, mesh: MeshData, out: Writable): void {
    this.vertexWorld(slot, mesh, 0, mesh.vertexCount * 2, out, 0);
  }

  /**
   * Vertices `start / 2` on, `count / 2` of them, of a mesh or path in world
   * space (y up), into `out` from `offset`: unweighted through the slot's
   * bone, weighted as the weighted sum of each influence through its own
   * bone; the slot's deform keys added in either case.
   */
  vertexWorld(slot: number, att: MeshData | PathData | ClippingData | BoxData, start: number, count: number, out: Writable, offset: number): void {
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
  private timelineDeform(slot: number, _att: MeshData | PathData | ClippingData | BoxData): Float64Array | null {
    return this.deform[slot] ?? null;
  }

  /** Show `key` in the slot. A change restarts its sequence, and drops its
   *  deform unless the new attachment plays the same deform keys. */
  setAttachment(slot: number, key: string | null): void {
    if (this.attachment[slot] === key) return;
    const before = this.attachmentOf(slot);
    this.attachment[slot] = key;
    const after = this.attachmentOf(slot);
    if (before === after) return;
    if (!before || !after || before.kind === "region" || after.kind === "region" || before.timeline !== after.timeline) this.deform[slot] = null;
    this.sequenceIndex[slot] = -1;
  }

  /** A point attachment's world position and angle (degrees), through its slot's bone. */
  pointWorld(slot: number, point: PointData): { x: number; y: number; rotation: number } {
    const W = this.world, w = this.data.slots[slot]!.bone * 6;
    const a = W[w]!, b = W[w + 1]!, c = W[w + 2]!, d = W[w + 3]!;
    const r = point.rotation * DEG_RAD, cos = Math.cos(r), sin = Math.sin(r);
    return {
      x: a * point.x + b * point.y + W[w + 4]!,
      y: c * point.x + d * point.y + W[w + 5]!,
      // Its x axis through the bone's matrix.
      rotation: Math.atan2(cos * c + sin * d, cos * a + sin * b) / DEG_RAD,
    };
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

/** Where vertices are written: a typed array or a plain one. */
export type Writable = { [index: number]: number };

/** How a timeline mixes: from the setup pose, from the current value
 *  ("first" fading back to the setup pose before its first key), or added. */
export type Blend = "setup" | "first" | "replace" | "add";

const PROP_OFFSET = { x: 0, y: 1, rotate: 2, scaleX: 3, scaleY: 4, shearX: 5, shearY: 6 } as const;
const PROP_FIELD = { x: "x", y: "y", rotate: "rotation", scaleX: "scaleX", scaleY: "scaleY", shearX: "shearX", shearY: "shearY" } as const;

/** An absolute value (a constraint's mix, a path's position) mixed by
 *  `alpha`; `value` null before the timeline's first key. */
function absoluteValue(value: number | null, alpha: number, blend: Blend, current: number, setup: number): number {
  if (value === null) return blend === "setup" ? setup : blend === "first" ? current + (setup - current) * alpha : current;
  return blend === "setup" ? setup + (value - setup) * alpha : current + (value - current) * alpha;
}

/**
 * A scale key's value (already times the setup scale) mixed by `alpha`.
 * Mixing never passes through 0: going in, the base takes the key's sign;
 * going out, the key takes the base's.
 */
function scaleValue(value: number, alpha: number, blend: Blend, out: boolean, current: number, setup: number): number {
  if (alpha === 1) return blend === "add" ? current + value - setup : value;
  if (blend === "add") return current + (value - setup) * alpha;
  const base = blend === "setup" ? setup : current;
  if (out) return base + (Math.abs(value) * Math.sign(base) - base) * alpha;
  const s = Math.abs(base) * Math.sign(value);
  return s + (value - s) * alpha;
}

function physicsSetup(k: Extract<RigData["constraints"][number], { kind: "physics" }>): PhysicsPose {
  return { inertia: k.inertia, strength: k.strength, damping: k.damping, massInverse: k.massInverse, wind: k.wind, gravity: k.gravity, mix: k.mix };
}
