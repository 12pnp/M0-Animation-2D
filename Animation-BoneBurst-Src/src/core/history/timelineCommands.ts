import { type Command, mergeTouches, type TouchSet } from "./Command";
import type { Animation, AnimationReference, DrawOrderKey, EventDef, EventKey, IkKey, Keyframe, Project, Track } from "@/core/doc/types";
import type { AnimId, IkId, ItemId, NodeId } from "@/core/doc/ids";
import type { ChannelEases, TweenSpec } from "@/core/math/easing";
import { createAnimation } from "@/core/doc/defaults";
import { endAfterResize } from "@/core/doc/timeline";
import { invalidateBounds } from "@/core/doc/pose";
import { withTransform } from "@/core/doc/keyed";
import { symbolOf, animOf } from "./lookup";
import { SetAnimKeys, withListAt } from "./animKeysCommand";

/**
 * One primitive for every timeline edit.
 *
 * All the Flash frame operations in `core/doc/timeline.ts` are pure functions
 * that take a Track and return a new one, so the command layer does not need
 * to know what any of them mean: it snapshots the tracks it is about to
 * replace and swaps them back on undo. That keeps the undo path identical —
 * and identically correct — for inserting a frame, dragging a keyframe, or
 * writing a transform from the stage.
 *
 * `undefined` on either side means "no track", which is how track creation
 * and deletion fall out for free.
 */
export class EditTracks implements Command {
  readonly kind: string;
  readonly touches: TouchSet;
  private before = new Map<NodeId, Track | undefined>();
  private after: Map<NodeId, Track | undefined>;
  private captured = false;
  private beforeDuration = 0;

  constructor(
    readonly label: string,
    private readonly symbolId: ItemId,
    private readonly animId: AnimId,
    tracks: Map<NodeId, Track | undefined>,
    /** Same-kind commands merge during an interaction, so a drag is one undo. */
    kind = "timeline.edit",
  ) {
    this.after = new Map(tracks);
    this.kind = kind;
    this.touches = {
      symbols: [symbolId],
      nodes: [...tracks.keys()],
      timeline: true,
      stage: true,
    };
  }

  apply(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    if (!this.captured) {
      for (const id of this.after.keys()) this.before.set(id, anim.tracks[id]);
      this.captured = true;
    }
    this.beforeDuration = anim.duration;
    for (const [id, track] of this.after) {
      if (track) anim.tracks[id] = track;
      else delete anim.tracks[id];
    }
    anim.duration = durationFor(anim);
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    for (const [id, track] of this.before) {
      if (track) anim.tracks[id] = track;
      else delete anim.tracks[id];
    }
    anim.duration = this.beforeDuration;
    invalidateBounds([this.symbolId]);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof EditTracks)) return false;
    if (next.symbolId !== this.symbolId || next.animId !== this.animId) return false;
    if (next.kind !== this.kind) return false;
    for (const [id, track] of next.after) {
      // A track only a later step touched: that step saw it untouched, so
      // its `before` is the original, and undo has to put it back too.
      if (!this.before.has(id)) {
        this.before.set(id, next.before.get(id));
        this.touches.nodes?.push(id);
      }
      this.after.set(id, track);
    }
    return true;
  }

  estimateSize(): number {
    let n = 0;
    for (const t of this.before.values()) n += (t?.keys.length ?? 0) * 160;
    return n + 128;
  }
}

/**
 * An animation is as long as its longest layer, the way a Flash timeline is.
 *
 * Dragging a span or a keyframe past the end therefore lengthens the
 * animation, and pulling the last one back shortens it, with no separate
 * "duration" setting to keep in sync. When nothing is keyed there is nothing
 * to measure, so the stored value stands — that is what `Set Duration…` sets.
 */
export function durationFor(anim: Animation): number {
  let end = -1;
  for (const track of Object.values(anim.tracks)) {
    if (track) end = Math.max(end, track.endFrame);
  }
  return end < 0 ? Math.max(1, anim.duration) : Math.max(1, end + 1);
}

/* ── Animation-level edits ───────────────────────────────────────────────*/

export class SetAnimationDuration implements Command {
  readonly kind = "anim.duration";
  readonly touches: TouchSet;
  readonly label = "Change Duration";
  /** The duration before the first step; a redo starts from it again. */
  private before: number | null = null;

  constructor(
    private readonly symbolId: ItemId,
    private readonly animId: AnimId,
    private duration: number,
  ) {
    this.touches = { symbols: [symbolId], timeline: true, stage: true };
  }

  /** Every track as it was before the first step, stretched or not: a later
   *  step of a scrub may move one this step left alone. */
  private beforeTracks = new Map<NodeId, Track>();

  apply(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    this.before ??= anim.duration;
    const next = Math.max(1, Math.round(this.duration));
    anim.duration = next;
    // Duration is derived from the spans, so setting it explicitly has to
    // move the ones that reach the end; otherwise the next track edit would
    // snap it straight back. New tracks: the old ones belong to earlier undo
    // steps too.
    for (const [id, track] of Object.entries(anim.tracks) as Array<[NodeId, Track | undefined]>) {
      if (!track) continue;
      if (!this.beforeTracks.has(id)) this.beforeTracks.set(id, track);
      const endFrame = endAfterResize(track, this.before, next);
      if (endFrame !== track.endFrame) anim.tracks[id] = { ...track, endFrame };
    }
    anim.duration = durationFor(anim);
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    for (const [id, track] of this.beforeTracks) anim.tracks[id] = track;
    if (this.before !== null) anim.duration = this.before;
    invalidateBounds([this.symbolId]);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetAnimationDuration) || next.animId !== this.animId) return false;
    if (next.symbolId !== this.symbolId) return false;
    this.duration = next.duration;
    for (const [id, track] of next.beforeTracks) {
      if (!this.beforeTracks.has(id)) this.beforeTracks.set(id, track);
    }
    return true;
  }
}

/**
 * Turns an animation into a cycle or back (`core/doc/cycle.ts`). On: plays
 * forever on Spine's timing, with the length and the join keys `cyclePlan`
 * gives. Off: plays once, keys and timing untouched, so the export is the same.
 */
export class SetCycle implements Command {
  readonly kind = "anim.cycle";
  readonly touches: TouchSet;
  readonly label: string;
  private before: { playTimes: number; endsAtLastFrame: boolean; duration: number } | null = null;
  private beforeTracks = new Map<NodeId, Track | undefined>();

  constructor(
    private readonly symbolId: ItemId,
    private readonly animId: AnimId,
    private readonly on: boolean,
    private readonly plan: { duration: number; tracks: Track[] } = { duration: 0, tracks: [] },
    label?: string,
  ) {
    this.label = label ?? (on ? "Cycle" : "Play Once");
    this.touches = { symbols: [symbolId], nodes: plan.tracks.map((t) => t.nodeId), timeline: true, stage: true };
  }

  apply(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    this.before = { playTimes: anim.playTimes, endsAtLastFrame: anim.endsAtLastFrame === true, duration: anim.duration };
    if (!this.on) {
      anim.playTimes = 1;
      return;
    }
    anim.playTimes = 0;
    anim.endsAtLastFrame = true;
    for (const t of this.plan.tracks) {
      if (!this.beforeTracks.has(t.nodeId)) this.beforeTracks.set(t.nodeId, anim.tracks[t.nodeId]);
      anim.tracks[t.nodeId] = t;
    }
    anim.duration = Math.max(this.plan.duration, durationFor(anim));
    invalidateBounds([this.symbolId]);
  }

  revert(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim || !this.before) return;
    for (const [id, t] of this.beforeTracks) {
      if (t) anim.tracks[id] = t;
      else delete anim.tracks[id];
    }
    anim.playTimes = this.before.playTimes;
    if (this.before.endsAtLastFrame) anim.endsAtLastFrame = true;
    else delete anim.endsAtLastFrame;
    anim.duration = this.before.duration;
    invalidateBounds([this.symbolId]);
  }
}

export class AddAnimation implements Command {
  readonly kind = "anim.add";
  readonly touches: TouchSet;
  readonly animation: Animation;

  constructor(private readonly symbolId: ItemId, name: string, duration = 1, readonly label = "New Animation") {
    this.animation = createAnimation(name, duration);
    this.touches = { symbols: [symbolId], timeline: true };
  }
  apply(p: Project): void {
    symbolOf(p, this.symbolId).animations.push(this.animation);
    invalidateBounds([this.symbolId]);
  }
  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    sym.animations = sym.animations.filter((a) => a.id !== this.animation.id);
    invalidateBounds([this.symbolId]);
  }
}

export class RemoveAnimation implements Command {
  readonly kind = "anim.remove";
  readonly touches: TouchSet;
  readonly label = "Delete Animation";
  private removed: Animation | null = null;
  private index = -1;

  constructor(private readonly symbolId: ItemId, private readonly animId: AnimId) {
    this.touches = { symbols: [symbolId], timeline: true };
  }
  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    // An armature with no animation cannot be played at all; keep the last one.
    if (sym.animations.length <= 1) return;
    this.index = sym.animations.findIndex((a) => a.id === this.animId);
    if (this.index < 0) return;
    this.removed = sym.animations[this.index]!;
    sym.animations.splice(this.index, 1);
    invalidateBounds([this.symbolId]);
  }
  revert(p: Project): void {
    if (!this.removed) return;
    symbolOf(p, this.symbolId).animations.splice(this.index, 0, this.removed);
    invalidateBounds([this.symbolId]);
  }
  estimateSize(): number { return JSON.stringify(this.removed ?? {}).length * 2; }
}

export class RenameAnimation implements Command {
  readonly kind = "anim.rename";
  readonly touches: TouchSet;
  readonly label = "Rename Animation";
  private before = "";

  constructor(
    private readonly symbolId: ItemId,
    private readonly animId: AnimId,
    private readonly name: string,
  ) {
    this.touches = { symbols: [symbolId], timeline: true };
  }
  apply(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    this.before = anim.name;
    anim.name = this.name;
    invalidateBounds([this.symbolId]);
  }
  revert(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (anim) anim.name = this.before;
    invalidateBounds([this.symbolId]);
  }
}

/* ── Helpers used by the panel and the stage ─────────────────────────────*/

/** Replace one keyframe within a track, returning a NEW track. */
export function withKeyframe(track: Track, frame: number, patch: Partial<Keyframe>): Track {
  return {
    ...track,
    keys: track.keys.map((k) => {
      if (k.frame !== frame) return k;
      // A new pose keys the properties it changes (`Keyframe.keyed`).
      const posed = patch.transform ? withTransform(k, patch.transform) : k;
      return { ...posed, ...patch, ...(posed.keyed ? { keyed: posed.keyed } : {}) };
    }),
  };
}

export function withTween(track: Track, frame: number, tween: TweenSpec): Track {
  return withKeyframe(track, frame, { tween });
}

/** The whole ease of the interval leaving `frame`: default plus overrides. */
export function withEases(track: Track, frame: number, tween: TweenSpec, eases: ChannelEases | undefined): Track {
  return {
    ...track,
    keys: track.keys.map((k) => {
      if (k.frame !== frame) return k;
      const next = { ...k, tween };
      if (eases && Object.keys(eases).length) next.eases = eases;
      else delete next.eases;
      return next;
    }),
  };
}

/** An animation's reference art (`Animation.reference`), replaced whole;
 *  undefined removes it. The images stay in the asset store for undo; the
 *  project file keeps only what something still shows. */
export class SetAnimationReference implements Command {
  readonly kind = "anim.reference";
  readonly touches: TouchSet;
  private before: AnimationReference | undefined;
  private captured = false;

  constructor(
    private readonly symbolId: ItemId, private readonly animId: AnimId,
    private readonly next: AnimationReference | undefined, readonly label = "Change Reference",
  ) {
    this.touches = { symbols: [symbolId], timeline: true, stage: true };
  }

  apply(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    if (!this.captured) { this.before = anim.reference; this.captured = true; }
    if (this.next) anim.reference = { ...this.next, frames: [...this.next.frames] };
    else delete anim.reference;
  }

  revert(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    if (this.before) anim.reference = this.before;
    else delete anim.reference;
  }
}

/** The animation's key-pose frames (the Poses panel), set whole in one step. */
export class SetAnimationPoses implements Command {
  readonly kind = "anim.poses";
  readonly touches: TouchSet;
  private before: number[] | undefined;
  private captured = false;

  constructor(
    private readonly symbolId: ItemId, private readonly animId: AnimId,
    private readonly next: number[] | undefined, readonly label = "Change Poses",
  ) {
    this.touches = { symbols: [symbolId], timeline: true, stage: true };
  }

  apply(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    if (!this.captured) { this.before = anim.poses; this.captured = true; }
    if (this.next && this.next.length) anim.poses = [...this.next];
    else delete anim.poses;
  }

  revert(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    if (this.before && this.before.length) anim.poses = [...this.before];
    else delete anim.poses;
  }
}

/** An animation's draw order keys replaced (`core/doc/drawOrder.ts`). Steps of
 *  one drag share a `kind` and merge into one undo. */
export class SetDrawOrder extends SetAnimKeys<DrawOrderKey[]> {
  constructor(label: string, symbolId: ItemId, animId: AnimId, after: DrawOrderKey[], kind = "timeline.drawOrder") {
    super(label, symbolId, animId, after, kind);
  }
  protected read(anim: Animation): DrawOrderKey[] | undefined { return anim.drawOrder; }
  protected write(anim: Animation, keys: DrawOrderKey[] | undefined): void {
    if (keys?.length) anim.drawOrder = keys; else delete anim.drawOrder;
  }
  protected sameList(): boolean { return true; }
}

/** One IK constraint's keys in an animation replaced (`core/doc/ikKeys.ts`).
 *  Steps of one drag share a `kind` and merge into one undo. */
export class SetIkKeys extends SetAnimKeys<IkKey[]> {
  constructor(label: string, symbolId: ItemId, animId: AnimId, private readonly ikId: IkId, after: IkKey[], kind = "timeline.ik") {
    super(label, symbolId, animId, after, kind);
  }
  protected read(anim: Animation): IkKey[] | undefined { return anim.ik?.[this.ikId]; }
  protected write(anim: Animation, keys: IkKey[] | undefined): void {
    const ik = withListAt(anim.ik, this.ikId, keys);
    if (ik) anim.ik = ik; else delete anim.ik;
  }
  protected sameList(next: this): boolean { return next.ikId === this.ikId; }
}

/** Tracks and one IK constraint's keys in one step, merging as a pair: a
 *  path drag that keys the target and may flip the bend
 *  (`core/doc/ikPathEdit.ts`). Both parts share `kind`. */
export class EditTracksAndIk implements Command {
  constructor(
    readonly label: string,
    private readonly tracks: EditTracks,
    private readonly ik: SetIkKeys,
    readonly kind: string,
  ) {}

  get touches(): TouchSet { return mergeTouches(this.tracks.touches, this.ik.touches); }

  apply(p: Project): void {
    this.tracks.apply(p);
    this.ik.apply(p);
  }

  revert(p: Project): void {
    this.ik.revert(p);
    this.tracks.revert(p);
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof EditTracksAndIk) || next.kind !== this.kind) return false;
    return this.tracks.mergeWith(next.tracks) && this.ik.mergeWith(next.ik);
  }
}

/** An animation's event keys replaced (`core/doc/events.ts`). Steps of one
 *  drag share a `kind` and merge into one undo. */
export class SetEventKeys implements Command {
  readonly touches: TouchSet;
  private before: EventKey[] | undefined;
  private captured = false;

  constructor(
    readonly label: string,
    private readonly symbolId: ItemId,
    private readonly animId: AnimId,
    private after: EventKey[],
    readonly kind = "timeline.events",
  ) {
    this.touches = { symbols: [symbolId], timeline: true };
  }

  apply(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    if (!this.captured) { this.before = anim.events; this.captured = true; }
    if (this.after.length) anim.events = this.after;
    else delete anim.events;
  }

  revert(p: Project): void {
    const anim = animOf(symbolOf(p, this.symbolId), this.animId);
    if (!anim) return;
    if (this.before) anim.events = this.before;
    else delete anim.events;
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetEventKeys) || next.kind !== this.kind) return false;
    if (next.symbolId !== this.symbolId || next.animId !== this.animId) return false;
    this.after = next.after;
    return true;
  }
}

/** A symbol's event list replaced, with the keys of the animations a rename
 *  or a delete changed (`renamedEvent`, `withoutEvent`). A field edit's
 *  steps share a `kind` and merge. */
export class SetEvents implements Command {
  readonly touches: TouchSet;
  private before: { defs: EventDef[] | undefined; keys: Map<AnimId, EventKey[] | undefined> } | null = null;

  constructor(
    readonly label: string,
    private readonly symbolId: ItemId,
    private after: EventDef[],
    private keys: Map<AnimId, EventKey[]> = new Map(),
    readonly kind = "events.list",
  ) {
    this.touches = { symbols: [symbolId], timeline: true };
  }

  apply(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (!sym) return;
    if (!this.before) {
      const keys = new Map<AnimId, EventKey[] | undefined>();
      for (const id of this.keys.keys()) keys.set(id, animOf(sym, id)?.events);
      this.before = { defs: sym.events, keys };
    }
    if (this.after.length) sym.events = this.after;
    else delete sym.events;
    for (const [id, keys] of this.keys) {
      const anim = animOf(sym, id);
      if (!anim) continue;
      if (keys.length) anim.events = keys;
      else delete anim.events;
    }
  }

  revert(p: Project): void {
    const sym = symbolOf(p, this.symbolId);
    if (!sym || !this.before) return;
    if (this.before.defs) sym.events = this.before.defs;
    else delete sym.events;
    for (const [id, keys] of this.before.keys) {
      const anim = animOf(sym, id);
      if (!anim) continue;
      if (keys) anim.events = keys;
      else delete anim.events;
    }
  }

  mergeWith(next: Command): boolean {
    if (!(next instanceof SetEvents) || next.kind !== this.kind || next.symbolId !== this.symbolId) return false;
    if (next.keys.size || this.keys.size) return false;
    this.after = next.after;
    return true;
  }
}
