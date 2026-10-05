import type { Store } from "./Store";
import type { Animation } from "@/core/doc/types";
import { SetAnimationPoses } from "@/core/history/timelineCommands";

/**
 * The animation's key-pose frames (`Animation.poses`): the Poses panel's
 * list, kept sorted and unique, one undo step per change. The frames are
 * just numbers — what makes a frame a pose is the user saying so.
 */
export class PosesService {
  constructor(private readonly store: Store) {}

  get current(): number[] {
    return [...(this.store.currentAnimation?.poses ?? [])];
  }

  /** Frames the animation already keys — the "good poses in the timeline"
   *  starting point, in time order. */
  static keyedFrames(anim: Animation | null | undefined): number[] {
    if (!anim) return [];
    const frames = new Set<number>();
    for (const track of Object.values(anim.tracks)) for (const k of track.keys ?? []) frames.add(k.frame);
    return [...frames].sort((a, b) => a - b);
  }

  /** Adds frames to the list (the union; duplicates fold away). */
  add(frames: number[], label = "Add Poses"): void {
    this.set([...this.current, ...frames], label);
  }

  remove(frame: number, label = "Remove Pose"): void {
    this.set(this.current.filter((f) => f !== frame), label);
  }

  /** One pose moved to another frame. */
  move(frame: number, to: number, label = "Move Pose"): void {
    this.set(this.current.map((f) => (f === frame ? to : f)), label);
  }

  private set(frames: number[], label: string): void {
    const anim = this.store.currentAnimation;
    if (!anim) return;
    const next = [...new Set(frames.map((f) => Math.max(0, Math.round(f))))].sort((a, b) => a - b);
    this.store.apply(new SetAnimationPoses(this.store.currentSymbolId, anim.id, next.length ? next : undefined, label));
  }
}
