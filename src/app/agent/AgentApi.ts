import type { Store } from "@/app/Store";
import type { AnimId, NodeId } from "@/core/doc/ids";
import type { Animation, Keyframe, Node, SymbolItem, Track } from "@/core/doc/types";
import { createKeyframe } from "@/core/doc/defaults";
import { insertKeyframe, keyIndexAt, setEndFrame } from "@/core/doc/timeline";
import { AddAnimation, EditTracks } from "@/core/history/timelineCommands";
import type { TweenSpec } from "@/core/math/easing";
import { CURVE_Y_LIMIT } from "@/core/math/easing";
import { posedSymbol } from "@/core/spine/spinePose";
import { exportSpine } from "@/core/spine/exportSpine";
import { fromSpineLocal, type SpineLocal, toSpineLocal } from "@/core/spine/transform";
import TOOLS from "./tools.json";

/**
 * The editor as tools an AI can call (`tools.json`): read the rig, its keys
 * and the pose the runtime draws; key bones, make animations, undo. Every
 * edit is ONE command through the Store's history, labelled "AI: …", so it
 * undoes like a manual one and the History panel shows who made it.
 *
 * Values are Spine's (x right, y UP, degrees counter-clockwise, local to
 * the parent bone): the rigs are Spine rigs, and a model knows Spine's
 * conventions better than the editor's Flash ones. `toSpineLocal` /
 * `fromSpineLocal` convert, exactly.
 *
 * The same class serves the MCP bridge and the prompt panel
 * (`AgentBridge.ts`); `check_preview` needs the page's Preview and is
 * handed in as `preview`.
 */

export interface AgentTool { name: string; description: string; input_schema: Record<string, unknown> }
export const AGENT_TOOLS = TOOLS as AgentTool[];

/** A tool call the model got wrong: said back to it, not thrown at the user. */
export class AgentError extends Error {}

/** The runtime's bone matrices at a frame ([a, b, c, d, x, y], y down), by
 *  bone name: the page's Preview. */
export interface PreviewProbe {
  matricesAt(animation: string, frame: number): Promise<Record<string, number[]>>;
}

type Args = Record<string, unknown>;
type SpineKeyIn = { bone: string; frame: number; x?: number; y?: number; rotation?: number; scaleX?: number; scaleY?: number; ease?: string | number[] };

const round = (v: number, digits = 4) => Math.round(v * 10 ** digits) / 10 ** digits;

export class AgentApi {
  constructor(private readonly store: Store, private readonly preview?: PreviewProbe) {}

  get tools(): AgentTool[] { return AGENT_TOOLS; }

  async call(name: string, args: Args = {}): Promise<unknown> {
    switch (name) {
      case "get_rig": return this.getRig();
      case "get_animation": return this.getAnimation(str(args, "animation"));
      case "get_pose": return this.getPose(args);
      case "new_animation": return this.newAnimation(str(args, "name"), int(args, "frames", 1));
      case "set_keys": return this.setKeys(str(args, "animation"), list<SpineKeyIn>(args, "keys"));
      case "delete_keys": return this.deleteKeys(str(args, "animation"), list<{ bone: string; frame: number }>(args, "keys"));
      case "show": return this.show(str(args, "animation"), typeof args.frame === "number" ? args.frame : 0);
      case "undo": return this.step("undo", typeof args.steps === "number" ? args.steps : 1);
      case "redo": return this.step("redo", typeof args.steps === "number" ? args.steps : 1);
      case "check_preview": return this.checkPreview(str(args, "animation"), args.frames);
      default: throw new AgentError(`There is no tool "${name}".`);
    }
  }

  /* ── reading ── */

  private get sym(): SymbolItem { return this.store.currentSymbol; }

  /** Nodes that are bones in Spine: everything but slots riding a bone and
   *  empty placeholders. */
  private bones(): Node[] {
    const s = this.sym;
    const order = s.layers.map((l) => s.nodes[l.nodeId]).filter((n): n is Node => !!n);
    return order.filter((n) => !n.slotBone && n.kind !== "empty");
  }

  private bone(name: string): Node {
    const found = this.bones().filter((n) => n.name === name);
    if (found.length === 0) throw new AgentError(`There is no bone "${name}". get_rig lists them.`);
    return found[0]!;
  }

  private animation(name: string): Animation {
    const anim = this.sym.animations.find((a) => a.name === name);
    if (!anim) throw new AgentError(`There is no animation "${name}". Animations: ${this.sym.animations.map((a) => `"${a.name}"`).join(", ")}.`);
    return anim;
  }

  /** Its length as Spine counts it: the frame where a loop wraps. */
  private frames(anim: Animation): number {
    return anim.endsAtLastFrame ? anim.duration - 1 : anim.duration;
  }

  private getRig() {
    const s = this.sym;
    const nameOf = (id: NodeId | null | undefined) => (id ? s.nodes[id]?.name ?? null : null);
    const anim = this.store.currentAnimation;
    return {
      name: s.name,
      fps: this.store.project.frameRate,
      bones: this.bones().map((n) => ({
        name: n.name,
        parent: nameOf(n.parentId),
        ...(n.boneLength ? { length: round(n.boneLength) } : {}),
        setup: spine(toSpineLocal(n.bind)),
        ...(n.inherit ? { inherit: n.inherit } : {}),
      })),
      slots: s.layers.map((l) => s.nodes[l.nodeId]).filter((n): n is Node => !!n && (n.kind === "image" || n.kind === "symbol"))
        .reverse().map((n) => ({ name: n.name, bone: nameOf(n.slotBone) ?? n.name })),
      ik: s.ik.map((k) => {
        const effector = s.nodes[k.boneId];
        const bones = k.chain > 0 && effector?.parentId ? [nameOf(effector.parentId), effector.name] : [effector?.name];
        return { name: k.name, bones, target: nameOf(k.targetId), mix: k.weight };
      }),
      animations: s.animations.map((a) => ({ name: a.name, frames: this.frames(a), loops: a.playTimes === 0 })),
      showing: { animation: anim?.name ?? null, frame: this.store.ui.frame },
    };
  }

  private getAnimation(name: string) {
    const anim = this.animation(name);
    const bones: Record<string, unknown[]> = {};
    for (const n of this.bones()) {
      const track = anim.tracks[n.id];
      if (!track) continue;
      bones[n.name] = track.keys.map((k) => ({ frame: k.frame, ...spine(toSpineLocal(k.transform)), ease: easeName(k) }));
    }
    return { name: anim.name, frames: this.frames(anim), loops: anim.playTimes === 0, fps: this.store.project.frameRate, bones };
  }

  private getPose(args: Args) {
    const animName = typeof args.animation === "string" ? args.animation : null;
    const anim = animName ? this.animation(animName) : null;
    const frame = typeof args.frame === "number" ? args.frame : 0;
    const wanted = Array.isArray(args.bones) ? new Set(args.bones.map(String)) : null;
    const pose = posedSymbol(this.store.project, this.sym, anim, frame, anim ? "animate" : "setup");
    const out: Record<string, unknown> = {};
    for (const n of this.bones()) {
      if (wanted && !wanted.has(n.name)) continue;
      const m = pose.byNode.get(n.id)?.world;
      if (!m) continue;
      // The editor's world is y down; back to Spine's y up.
      out[n.name] = {
        x: round(m.tx, 2), y: round(-m.ty, 2),
        rotation: round((Math.atan2(-m.b, m.a) * 180) / Math.PI, 2),
        scaleX: round(Math.hypot(m.a, m.b)), scaleY: round(Math.hypot(m.c, m.d)),
      };
    }
    if (wanted) for (const b of wanted) if (!out[b]) throw new AgentError(`There is no bone "${b}".`);
    return { animation: anim?.name ?? null, frame, bones: out };
  }

  /* ── editing ── */

  private newAnimation(name: string, frames: number) {
    if (!name.trim()) throw new AgentError("An animation needs a name.");
    if (this.sym.animations.some((a) => a.name === name)) throw new AgentError(`There is already an animation "${name}".`);
    const cmd = new AddAnimation(this.store.currentSymbolId, name, frames + 1, `AI: New Animation "${name}"`);
    // Spine's timing: the loop wraps at `frames`, where its last pose is keyed.
    cmd.animation.endsAtLastFrame = true;
    this.store.apply(cmd);
    this.store.emit("timeline");
    return { created: name, frames };
  }

  private setKeys(animName: string, keys: SpineKeyIn[]) {
    const anim = this.animation(animName);
    const tracks = new Map<NodeId, Track>();
    for (const k of keys) {
      if (typeof k.bone !== "string") throw new AgentError("Each key needs a bone.");
      if (!Number.isInteger(k.frame) || k.frame < 0) throw new AgentError(`Key for "${k.bone}": frame must be a whole number, 0 or more.`);
      const node = this.bone(k.bone);
      let track = tracks.get(node.id) ?? anim.tracks[node.id] ?? {
        // A bone keyed for the first time starts from its setup pose at 0.
        // It spans the animation, as a track made on the timeline does.
        nodeId: node.id, keys: [{ ...createKeyframe(0, node), tween: { kind: "linear" } as TweenSpec }], endFrame: Math.max(0, anim.duration - 1),
      };
      if (k.frame > track.endFrame) track = setEndFrame(track, k.frame);
      let i = keyIndexAt(track, k.frame);
      const fresh = i < 0;
      if (fresh) {
        track = insertKeyframe(track, k.frame, node) ?? track;
        i = keyIndexAt(track, k.frame);
      }
      const key = track.keys[i]!;
      const now = toSpineLocal(key.transform);
      const next: SpineLocal = { ...now };
      for (const ch of ["x", "y", "rotation", "scaleX", "scaleY"] as const) {
        const v = k[ch];
        if (v === undefined) continue;
        if (typeof v !== "number" || !Number.isFinite(v)) throw new AgentError(`Key for "${k.bone}" at ${k.frame}: ${ch} must be a number.`);
        next[ch] = v;
      }
      const patch: Partial<Keyframe> = { transform: fromSpineLocal(next) };
      if (k.ease !== undefined) patch.tween = tweenOf(k.ease);
      else if (fresh) patch.tween = { kind: "linear" };
      const replaced: Keyframe = { ...key, ...patch };
      if (patch.tween) delete replaced.eases;
      track = { ...track, keys: track.keys.map((x, n) => (n === i ? replaced : x)) };
      tracks.set(node.id, track);
    }
    this.commit(anim, `AI: Set ${keys.length} key${keys.length === 1 ? "" : "s"}`, tracks);
    return { animation: anim.name, keys: keys.length, bones: [...new Set(keys.map((k) => k.bone))], frames: this.frames(this.animation(animName)) };
  }

  private deleteKeys(animName: string, keys: Array<{ bone: string; frame: number }>) {
    const anim = this.animation(animName);
    const tracks = new Map<NodeId, Track | undefined>();
    let removed = 0;
    for (const k of keys) {
      const node = this.bone(k.bone);
      const track = tracks.has(node.id) ? tracks.get(node.id) : anim.tracks[node.id];
      if (!track || keyIndexAt(track, k.frame) < 0) throw new AgentError(`"${k.bone}" has no key at frame ${k.frame}.`);
      const left = track.keys.filter((x) => x.frame !== k.frame);
      tracks.set(node.id, left.length ? { ...track, keys: left } : undefined);
      removed++;
    }
    this.commit(anim, `AI: Delete ${removed} key${removed === 1 ? "" : "s"}`, tracks);
    return { animation: anim.name, removed };
  }

  private commit(anim: Animation, label: string, tracks: Map<NodeId, Track | undefined>): void {
    this.store.transaction(label, () => {
      this.store.apply(new EditTracks(label, this.store.currentSymbolId, anim.id as AnimId, tracks, "agent.keys"));
    });
    this.store.emit("timeline");
    this.store.emit("stage");
  }

  private show(animName: string, frame: number) {
    const anim = this.animation(animName);
    this.store.setUi({ animId: anim.id }, "timeline");
    this.store.setFrame(Math.max(0, Math.round(frame)));
    return { showing: anim.name, frame: this.store.ui.frame };
  }

  private step(which: "undo" | "redo", steps: number) {
    const done: string[] = [];
    for (let i = 0; i < Math.max(1, Math.min(50, Math.round(steps))); i++) {
      const label = which === "undo" ? this.store.history.undoLabel : this.store.history.redoLabel;
      if (!label) break;
      if (which === "undo") this.store.undo(); else this.store.redo();
      done.push(label);
    }
    return { [which === "undo" ? "undone" : "redone"]: done };
  }

  /* ── checking ── */

  private async checkPreview(animName: string, framesArg: unknown) {
    if (!this.preview) throw new AgentError("The Preview is not available here: open the Preview panel.");
    const anim = this.animation(animName);
    const last = this.frames(anim);
    const frames = Array.isArray(framesArg)
      ? framesArg.map(Number).filter((f) => Number.isInteger(f) && f >= 0)
      : Array.from({ length: Math.min(last + 1, 121) }, (_, i) => Math.round((i * last) / Math.min(last, 120)));
    // The runtime knows bones by their exported names.
    const names = exportSpine(this.store.project, this.sym.id, { setupOnly: true }).names;
    let worst = 0, where = "";
    for (const f of [...new Set(frames)]) {
      const runtime = await this.preview.matricesAt(anim.name, f);
      const pose = posedSymbol(this.store.project, this.sym, anim, f, "animate");
      for (const n of this.bones()) {
        const m = pose.byNode.get(n.id)?.world, r = runtime[names.get(n.id) ?? n.name];
        if (!m || !r) continue;
        const d = Math.max(Math.abs(m.tx - r[4]!), Math.abs(m.ty - r[5]!));
        if (d > worst) { worst = d; where = `"${n.name}" at frame ${f}`; }
      }
    }
    return { animation: anim.name, framesChecked: new Set(frames).size, worstPixels: round(worst, 6), ...(where ? { worstAt: where } : {}), matches: worst <= 0.01 };
  }
}

/* ── helpers ── */

function spine(l: SpineLocal) {
  const out: Record<string, number> = { x: round(l.x), y: round(l.y), rotation: round(l.rotation), scaleX: round(l.scaleX), scaleY: round(l.scaleY) };
  if (l.shearY) out.shearY = round(l.shearY);
  return out;
}

function tweenOf(ease: string | number[]): TweenSpec {
  if (Array.isArray(ease)) {
    if (ease.length !== 4 || !ease.every((v) => typeof v === "number" && Number.isFinite(v))) throw new AgentError("A bezier ease is four numbers: [x1, y1, x2, y2].");
    const [x1, y1, x2, y2] = ease as [number, number, number, number];
    const x = (v: number) => Math.min(1, Math.max(0, v)), y = (v: number) => Math.min(CURVE_Y_LIMIT, Math.max(-CURVE_Y_LIMIT, v));
    return { kind: "curve", curve: [x(x1), y(y1), x(x2), y(y2)] };
  }
  switch (ease) {
    case "linear": return { kind: "linear" };
    case "hold": return { kind: "none" };
    case "in": return { kind: "ease", value: -1 };
    case "out": return { kind: "ease", value: 1 };
    case "inout": return { kind: "ease", value: 2 };
    default: throw new AgentError(`Unknown ease "${ease}": linear, hold, in, out, inout, or [x1, y1, x2, y2].`);
  }
}

function easeName(k: Keyframe): string | number[] {
  const t = k.tween;
  const base = t.kind === "none" ? "hold" : t.kind === "linear" ? "linear"
    : t.kind === "ease" ? (t.value < 0 ? "in" : t.value <= 1 ? "out" : "inout")
    : t.kind === "curve" && t.curve.length === 4 ? t.curve.map((v) => round(v)) : "custom";
  return k.eases && Object.keys(k.eases).length ? `${Array.isArray(base) ? "curve" : base} (per-property overrides)` : base;
}

function str(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new AgentError(`"${key}" is required, as text.`);
  return v;
}

function int(args: Args, key: string, min: number): number {
  const v = args[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < min) throw new AgentError(`"${key}" must be a whole number of at least ${min}.`);
  return v;
}

function list<T>(args: Args, key: string): T[] {
  const v = args[key];
  if (!Array.isArray(v) || v.length === 0) throw new AgentError(`"${key}" must be a non-empty list.`);
  return v as T[];
}
