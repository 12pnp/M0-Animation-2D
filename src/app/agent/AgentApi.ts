import type { Store } from "@/app/Store";
import { type AnimId, type AssetId, newIkId, type NodeId } from "@/core/doc/ids";
import { type Animation, type ImageItem, isImage, type Keyframe, type Node, type SymbolItem, type Track } from "@/core/doc/types";
import { entryBox, type FrameContext } from "@/core/doc/pose";
import { type ImageFrame, imageFrame, referenceEnd, referenceFrameOf, referenceIndexAt, referenceRect } from "@/core/doc/reference";
import { apply } from "@/core/math/Matrix2D";
import { pt, type Rect, transformCorners } from "@/core/math/geom";
import { createKeyframe, createLayer, createNode } from "@/core/doc/defaults";
import { ikRoles } from "@/core/doc/ikGraph";
import { insertKeyframe, keyIndexAt, setEndFrame } from "@/core/doc/timeline";
import { AddAnimation, EditTracks } from "@/core/history/timelineCommands";
import { AddNode, createsCycle, SetLayerOrder, SetParent, SetPivot, SetStageSkins } from "@/core/history/commands";
import { AddIkConstraint } from "@/core/history/ikCommands";
import { boneFromWorld, placeOnBone, siblingOrder, type SpinePoint } from "@/core/rig/rigPlan";
import type { ChannelEases, TweenSpec } from "@/core/math/easing";
import { CURVE_Y_LIMIT, easeOf, sameEase } from "@/core/math/easing";
import { posedSymbol, skinsOf, stageSkinOf } from "@/core/spine/spinePose";
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

/** A picture for the model, base64. */
export interface AgentImage { mimeType: string; data: string }

/** A tool's value carries its pictures under this key; the bridge lifts
 *  them out into image blocks (MCP, Claude, GLM's vision models). */
export const IMAGES_KEY = "__images";

/** A bone drawn over a picture: from its origin to its tip, in pixels. */
export interface BoneMark { name: string; from: [number, number]; to: [number, number] }

/** What the model can look at: the page's canvases (`view/agent/AgentVision.ts`).
 *  The geometry is worked out here; this only paints and encodes. */
export interface AgentVision {
  /** One reference image, its longer side at most `maxSide` pixels. */
  image(assetId: AssetId, maxSide: number): Promise<AgentImage>;
  /** The symbol at a frame as the stage draws it, through `view`, over its
   *  reference image when `reference` is set, with `bones` marked and named.
   *  `artwork: false` leaves the pictures out and shows only the bones. */
  render(req: { symbol: SymbolItem; animation: Animation | null; frame: number; view: ImageFrame; reference: boolean; bones: BoneMark[]; artwork?: boolean }): Promise<AgentImage>;
}

/** How a pose is captured (`renderPoses`): the bones alone, the artwork
 *  alone, or one over the other. */
export type PoseStyle = "bones" | "artwork" | "both";

/** Longest side of a rendered frame and of a reference image, in pixels:
 *  enough to see a pose, few enough tokens to look at many. */
const RENDER_SIDE = 768, REFERENCE_SIDE = 512, MAX_IMAGES = 6;

type Args = Record<string, unknown>;
type BoneIn = { name: string; parent?: string; from?: number[]; to?: number[]; x?: number; y?: number; rotation?: number; length?: number };
type AttachIn = { bone: string; image?: string; layer?: string; name?: string; pivot?: number[]; at?: number[]; rotation?: number; scale?: number };
type SpineKeyIn = {
  bone: string; frame: number; x?: number; y?: number; rotation?: number; scaleX?: number; scaleY?: number;
  ease?: string | number[]; eases?: Partial<Record<AxisName, string | number[]>>;
};

// + 0: no -0 in what the model reads.
const round = (v: number, digits = 4) => Math.round(v * 10 ** digits) / 10 ** digits + 0;

export class AgentApi {
  constructor(private readonly store: Store, private readonly preview?: PreviewProbe, private readonly vision?: AgentVision) {}

  get tools(): AgentTool[] { return AGENT_TOOLS; }

  async call(name: string, args: Args = {}): Promise<unknown> {
    switch (name) {
      case "get_rig": return this.getRig();
      case "get_animation": return this.getAnimation(str(args, "animation"));
      case "get_pose": return this.getPose(args);
      case "new_animation": return this.newAnimation(str(args, "name"), int(args, "frames", 1));
      case "set_keys": return this.setKeys(str(args, "animation"), list<SpineKeyIn>(args, "keys"));
      case "delete_keys": return this.deleteKeys(str(args, "animation"), list<{ bone: string; frame: number }>(args, "keys"));
      case "show": return this.show(str(args, "animation"), typeof args.frame === "number" ? args.frame : 0, args.skins);
      case "undo": return this.step("undo", typeof args.steps === "number" ? args.steps : 1);
      case "redo": return this.step("redo", typeof args.steps === "number" ? args.steps : 1);
      case "check_preview": return this.checkPreview(str(args, "animation"), args.frames);
      case "get_reference": return this.getReference(str(args, "animation"), args.frames);
      case "render_frame": return this.renderFrame(typeof args.animation === "string" ? args.animation : null, args.frame === undefined ? 0 : int(args, "frame", 0), args.reference !== false, args.bones !== false);
      case "add_bones": return this.addBones(list<BoneIn>(args, "bones"));
      case "attach": return this.attach(list<AttachIn>(args, "items"));
      case "add_ik": return this.addIk(str(args, "bone"), args);
      case "draw_order": return this.drawOrder(typeof args.parent === "string" ? args.parent : null, list<string>(args, "front"));
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
    const setup = posedSymbol(this.store.project, s, null, 0, "setup");
    // Where a picture is: its pivot pixel in skeleton space, which with the
    // size and the bone's turn is enough to read any of its pixels.
    const picture = (n: Node) => {
      const item = n.kind === "image" && !n.slotBone && n.itemId ? this.store.project.items[n.itemId] : undefined;
      const m = setup.byNode.get(n.id)?.world;
      if (!item || !isImage(item) || !m) return {};
      return {
        image: item.name, size: [item.width, item.height], pivot: [round(n.pivot.x, 2), round(n.pivot.y, 2)],
        at: [round(m.tx, 2), round(-m.ty, 2)], rotation: round((Math.atan2(-m.b, m.a) * 180) / Math.PI, 2),
      };
    };
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
        .reverse().map((n) => ({ name: n.name, bone: nameOf(n.slotBone) ?? n.name, ...picture(n) })),
      ik: s.ik.map((k) => {
        const effector = s.nodes[k.boneId];
        const bones = k.chain > 0 && effector?.parentId ? [nameOf(effector.parentId), effector.name] : [effector?.name];
        return { name: k.name, bones, target: nameOf(k.targetId), mix: k.weight };
      }),
      animations: s.animations.map((a) => ({
        name: a.name, frames: this.frames(a), loops: a.playTimes === 0,
        ...(a.reference ? { reference: { images: a.reference.frames.length, frames: [referenceFrameOf(a.reference, 0), referenceEnd(a.reference)] } } : {}),
      })),
      ...(skinsOf(s).some((n) => n !== "default") ? { skins: skinsOf(s).filter((n) => n !== "default") } : {}),
      images: this.libraryImages().map((i) => ({ name: i.name, width: i.width, height: i.height })),
      showing: { animation: anim?.name ?? null, frame: this.store.ui.frame, ...(s.spine ? { skins: stageSkinOf(s) } : {}) },
    };
  }

  private getAnimation(name: string) {
    const anim = this.animation(name);
    const bones: Record<string, unknown[]> = {};
    for (const n of this.bones()) {
      const track = anim.tracks[n.id];
      if (!track) continue;
      bones[n.name] = track.keys.map((k) => {
        const own = axisEases(k);
        return { frame: k.frame, ...spine(toSpineLocal(k.transform)), ease: easeName(k.tween), ...(own ? { eases: own } : {}) };
      });
    }
    return { name: anim.name, frames: this.frames(anim), loops: anim.playTimes === 0, fps: this.store.project.frameRate, bones,
      ...(anim.poses?.length ? { poses: [...anim.poses], note: "poses: the user's key-pose frames, already keyed — keep them as they are" } : {}) };
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
      if (k.eases !== undefined) {
        const eases = easesOf(k.eases, `Key for "${k.bone}" at ${k.frame}`);
        if (eases) replaced.eases = eases; else delete replaced.eases;
      } else if (patch.tween) delete replaced.eases;
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

  private show(animName: string, frame: number, skins: unknown) {
    const anim = this.animation(animName);
    if (skins !== undefined) {
      if (!Array.isArray(skins) || !skins.every((n) => typeof n === "string")) throw new AgentError("skins is a list of skin names.");
      const named = skinsOf(this.sym).filter((n) => n !== "default");
      const missing = skins.filter((n) => n !== "default" && !named.includes(n));
      if (missing.length) throw new AgentError(`There is no skin "${missing[0]}"; the rig has ${named.length ? named.join(", ") : "only the default skin"}.`);
      const next = named.filter((n) => skins.includes(n));
      if (JSON.stringify(next) !== JSON.stringify(stageSkinOf(this.sym)) || !this.sym.stageSkins) {
        this.store.apply(new SetStageSkins(this.sym.id, next, "AI: Show Skins"));
      }
    }
    this.store.setUi({ animId: anim.id }, "timeline");
    this.store.setFrame(Math.max(0, Math.round(frame)));
    return { showing: anim.name, frame: this.store.ui.frame, ...(this.sym.spine ? { skins: stageSkinOf(this.sym) } : {}) };
  }

  /* ── rigging ── */

  private libraryImages(): ImageItem[] {
    const p = this.store.project;
    return p.itemOrder.map((id) => p.items[id]).filter((i): i is ImageItem => !!i && isImage(i));
  }

  /** Every node but empty layers, by name: bones, and slots that ride one. */
  private node(name: string): Node {
    const found = Object.values(this.sym.nodes).find((n) => n.name === name && n.kind !== "empty");
    if (!found) throw new AgentError(`There is no bone or slot "${name}". get_rig lists them.`);
    return found;
  }

  private nameTaken(name: string): boolean {
    return Object.values(this.sym.nodes).some((n) => n.name === name);
  }

  /** A node's world matrix in the setup pose, as the runtime poses it. */
  private setupWorld(id: NodeId) {
    return posedSymbol(this.store.project, this.sym, null, 0, "setup").byNode.get(id)?.world;
  }

  private addBones(specs: BoneIn[]) {
    // Everything is checked before the first command: a transaction keeps
    // what it applied before a throw.
    const coming = new Set<string>();
    for (const b of specs) {
      if (typeof b.name !== "string" || !b.name.trim()) throw new AgentError("Each bone needs a name.");
      if (this.nameTaken(b.name) || coming.has(b.name)) throw new AgentError(`The name "${b.name}" is taken.`);
      if (b.parent !== undefined && !coming.has(b.parent)) this.bone(b.parent);
      if (b.from !== undefined || b.to !== undefined) {
        const from = point(b.from, `Bone "${b.name}": from`), to = point(b.to, `Bone "${b.name}": to`);
        if (from[0] === to[0] && from[1] === to[1]) throw new AgentError(`Bone "${b.name}": from and to are the same point.`);
        if (b.x !== undefined || b.y !== undefined || b.rotation !== undefined || b.length !== undefined) {
          throw new AgentError(`Bone "${b.name}": give from and to, or x, y, rotation and length, not both.`);
        }
      } else {
        for (const k of ["x", "y", "rotation", "length"] as const) {
          if (b[k] !== undefined && (typeof b[k] !== "number" || !Number.isFinite(b[k]))) throw new AgentError(`Bone "${b.name}": ${k} must be a number.`);
        }
        if (!(typeof b.length === "number" && b.length > 0)) throw new AgentError(`Bone "${b.name}": give from and to, or a length above 0.`);
      }
      coming.add(b.name);
    }
    const label = `AI: Add ${specs.length} bone${specs.length === 1 ? "" : "s"}`;
    this.store.transaction(label, () => {
      for (const b of specs) {
        const parent = b.parent !== undefined ? this.bone(b.parent) : null;
        const node = createNode("bone", b.name, { parentId: parent?.id ?? null });
        if (b.from) {
          const placed = boneFromWorld(parent ? this.setupWorld(parent.id) : undefined, b.from as unknown as SpinePoint, b.to as unknown as SpinePoint);
          if (!placed) throw new AgentError(`Bone "${b.name}": its parent "${b.parent}" is scaled to nothing.`);
          node.bind = placed.bind;
          node.boneLength = Math.max(1, round(placed.length, 2));
        } else {
          node.bind = fromSpineLocal({ x: b.x ?? 0, y: b.y ?? 0, rotation: b.rotation ?? 0, shearX: 0, shearY: 0, scaleX: 1, scaleY: 1 });
          node.boneLength = Math.max(1, round(b.length!, 2));
        }
        this.store.apply(new AddNode(label, this.store.currentSymbolId, node, createLayer(node.id, node.name, this.sym.layers.length), 0));
      }
    });
    return { added: specs.map((b) => b.name), note: "render_frame with no animation shows the setup pose" };
  }

  private attach(items: AttachIn[]) {
    const images = this.libraryImages();
    const coming = new Set<string>();
    const plans: Array<() => void> = [];
    const label = `AI: Attach ${items.length} picture${items.length === 1 ? "" : "s"}`;
    for (const it of items) {
      if (typeof it.bone !== "string") throw new AgentError("Each item needs a bone.");
      const bone = this.bone(it.bone);
      if (bone.kind !== "bone" && bone.kind !== "group") throw new AgentError(`"${it.bone}" is a slot, not a bone.`);
      if ((it.image === undefined) === (it.layer === undefined)) throw new AgentError(`On "${it.bone}": give either image (from the library) or layer (already in the skeleton).`);
      if (it.layer !== undefined) {
        for (const k of ["at", "rotation", "scale", "name"] as const) {
          if (it[k] !== undefined) throw new AgentError(`Layer "${it.layer}": ${k} is for a new image; a layer keeps where it is.`);
        }
        const node = this.node(it.layer);
        if (node.kind !== "image" && node.kind !== "symbol") throw new AgentError(`"${it.layer}" is a bone, not artwork.`);
        if (node.slotBone) throw new AgentError(`"${it.layer}" is a slot of an opened Spine rig; it already rides "${this.sym.nodes[node.slotBone]?.name}".`);
        if (createsCycle(this.sym, node.id, bone.id)) throw new AgentError(`"${it.bone}" hangs below "${it.layer}".`);
        if (ikRoles(this.sym).driven.has(node.id)) throw new AgentError(`"${it.layer}" is turned by IK; it cannot change parent.`);
        if (it.pivot !== undefined) {
          const [u, v] = point(it.pivot, `Layer "${it.layer}": pivot`);
          // The artwork stays where it is; only the point it turns about moves.
          plans.push(() => this.store.apply(new SetPivot(this.store.currentSymbolId, new Map([[node.id, { x: u, y: v }]]))));
        }
        plans.push(() => this.store.apply(new SetParent(this.store.currentSymbolId, [node.id], bone.id, true, label)));
        continue;
      }
      const image = images.find((i) => i.name === it.image);
      if (!image) throw new AgentError(`There is no picture "${it.image}" in the library. get_rig lists them under images.`);
      const name = it.name ?? image.name;
      if (this.nameTaken(name) || coming.has(name)) throw new AgentError(`The name "${name}" is taken: give this one a name.`);
      coming.add(name);
      const pivot = it.pivot === undefined ? [image.width / 2, image.height / 2] as const : point(it.pivot, `"${name}": pivot`);
      const scale = it.scale ?? 1;
      if (typeof scale !== "number" || !(scale > 0)) throw new AgentError(`"${name}": scale must be above 0.`);
      if (it.rotation !== undefined && (typeof it.rotation !== "number" || !Number.isFinite(it.rotation))) throw new AgentError(`"${name}": rotation must be a number.`);
      const boneWorld = this.setupWorld(bone.id);
      const at: SpinePoint = it.at === undefined ? [boneWorld?.tx ?? 0, -(boneWorld?.ty ?? 0)] : point(it.at, `"${name}": at`);
      const bind = placeOnBone(boneWorld, at, it.rotation ?? 0, scale);
      if (!bind) throw new AgentError(`"${it.bone}" is scaled to nothing.`);
      const node = createNode("image", name, { parentId: bone.id, itemId: image.id });
      node.pivot = { x: pivot[0], y: pivot[1] };
      node.bind = bind;
      plans.push(() => this.store.apply(new AddNode(label, this.store.currentSymbolId, node, createLayer(node.id, node.name, this.sym.layers.length), 0)));
    }
    this.store.transaction(label, () => { for (const run of plans) run(); });
    return { attached: items.map((it) => ({ bone: it.bone, slot: it.layer ?? it.name ?? it.image })) };
  }

  private addIk(boneName: string, args: Args) {
    const s = this.sym;
    const effector = this.bone(boneName);
    if (effector.kind !== "bone") throw new AgentError(`"${boneName}" is a slot; IK turns bones.`);
    const parent = effector.parentId ? s.nodes[effector.parentId] : undefined;
    // The runtime's rule (ARCHITECTURE ▸ Bones and IK): a bone parent roots the two-bone solve.
    const chain: 0 | 1 = parent?.kind === "bone" ? 1 : 0;
    const chainIds = chain ? [parent!.id, effector.id] : [effector.id];
    const root = s.nodes[chainIds[0]!]!;
    const driven = ikRoles(s).driven;
    for (const id of chainIds) if (driven.has(id)) throw new AgentError(`"${s.nodes[id]!.name}" is already turned by IK.`);
    for (const anim of s.animations) for (const id of chainIds) {
      if (anim.tracks[id]?.keys.length) throw new AgentError(`"${s.nodes[id]!.name}" has keys in "${anim.name}"; IK would fight them. Delete them first (delete_keys), then key the target instead.`);
    }
    const name = typeof args.name === "string" ? args.name : `${boneName}_ik`;
    if (s.ik.some((k) => k.name === name)) throw new AgentError(`There is already an IK constraint "${name}".`);
    if (args.bendPositive !== undefined && typeof args.bendPositive !== "boolean") throw new AgentError("bendPositive is true or false.");
    const mix = args.mix === undefined ? 1 : args.mix;
    if (typeof mix !== "number" || mix < 0 || mix > 1) throw new AgentError("mix is a number from 0 to 1.");

    let target: Node;
    let make: (() => void) | null = null;
    if (typeof args.target === "string") {
      target = this.bone(args.target);
      if (target.kind !== "bone") throw new AgentError(`The target "${args.target}" must be a bone.`);
      // A target inside the chain chases its own tail; the solve skips it.
      if (createsCycle(s, root.id, target.id)) throw new AgentError(`The target "${args.target}" is in the chain it would move: parent it outside "${root.name}".`);
    } else {
      const targetName = `${boneName}_target`;
      if (this.nameTaken(targetName)) throw new AgentError(`The name "${targetName}" is taken: give a target.`);
      const world = this.setupWorld(effector.id);
      const tip = world ? apply(pt(), world, effector.boneLength ?? 0, 0) : pt();
      const holderWorld = root.parentId ? this.setupWorld(root.parentId) : undefined;
      const bind = placeOnBone(holderWorld, [tip.x, -tip.y]);
      if (!bind) throw new AgentError(`"${root.name}"'s parent is scaled to nothing.`);
      target = createNode("bone", targetName, { parentId: root.parentId });
      target.bind = bind;
      target.boneLength = 20;
      const made = target;
      make = () => this.store.apply(new AddNode(`AI: Add ${targetName}`, this.store.currentSymbolId, made, createLayer(made.id, made.name, s.layers.length), 0));
    }
    const label = `AI: IK on ${boneName}`;
    this.store.transaction(label, () => {
      make?.();
      this.store.apply(new AddIkConstraint(this.store.currentSymbolId, {
        id: newIkId(), name, boneId: effector.id, targetId: target.id, chain,
        bendPositive: args.bendPositive !== false, weight: mix,
      }, label));
    });
    return { constraint: name, bones: chainIds.map((id) => s.nodes[id]!.name), target: target.name, ...(make ? { created: target.name } : {}) };
  }

  private drawOrder(parentName: string | null, front: string[]) {
    if (!front.every((n) => typeof n === "string")) throw new AgentError("front is a list of names.");
    const parentId = parentName === null ? null : this.node(parentName).id;
    const plan = siblingOrder(this.sym, parentId, front.map((n) => this.node(n).id));
    if (typeof plan === "string") throw new AgentError(plan);
    this.store.apply(new SetLayerOrder("AI: Draw Order", this.store.currentSymbolId, plan.map((l) => l.id)));
    const children = this.sym.layers.map((l) => this.sym.nodes[l.nodeId]!).filter((n) => (n.parentId ?? null) === parentId);
    return { parent: parentName, frontToBack: children.map((n) => n.name) };
  }

  /* ── looking ── */

  /** The animation's reference: how its images sit in time and space, and
   *  the images at the frames asked for. */
  private async getReference(animName: string, framesArg: unknown) {
    const anim = this.animation(animName);
    const ref = anim.reference;
    if (!ref) throw new AgentError(`"${anim.name}" has no reference. The user adds one in the Reference panel.`);
    const frames = framesArg === undefined ? [] : Array.isArray(framesArg) ? framesArg : [framesArg];
    if (!frames.every((f) => typeof f === "number" && Number.isInteger(f) && f >= 0)) throw new AgentError("frames is a list of whole frame numbers.");
    if (frames.length > MAX_IMAGES) throw new AgentError(`At most ${MAX_IMAGES} frames at a time.`);
    const images: AgentImage[] = [];
    const shown: Array<{ frame: number; image: number | null }> = [];
    for (const f of frames as number[]) {
      const i = referenceIndexAt(ref, f);
      shown.push({ frame: f, image: i === null ? null : i + 1 });
      if (i !== null) images.push(await this.needVision().image(ref.frames[i]!, REFERENCE_SIDE));
    }
    const r = referenceRect(ref);
    return {
      animation: anim.name,
      images: ref.frames.length,
      size: [ref.width, ref.height],
      timing: `image n (1-based) is keyed at keyFrames[n-1] and holds until the next image's keyFrame; the last holds ${ref.hold} frame(s); the reference ends at frame ${referenceEnd(ref)}`,
      keyFrames: ref.frames.map((_, i) => referenceFrameOf(ref, i)),
      // Spine conventions, as get_pose reports worlds: y up.
      placement: `image pixel (u, v) from its top-left sits at x = ${round(r.x, 3)} + u*${round(ref.scale, 6)}, y = ${round(-r.y, 3)} - v*${round(ref.scale, 6)} in the skeleton's space (the space get_pose reports)`,
      ...(shown.length ? { shown } : {}),
      [IMAGES_KEY]: images,
    };
  }

  /** The skeleton at a frame as the stage draws it, over its reference, with
   *  every bone drawn and named; and where each bone lands in the picture. */
  private async renderFrame(animName: string | null, frame: number, withReference: boolean, withBones: boolean) {
    const anim = animName === null ? null : this.animation(animName);
    const { boxes, bones } = this.frameView(anim, frame);
    // Framed on what is drawn: helper bones far from the artwork (an aim
    // target, a crosshair) would shrink the body to a corner. A rig that
    // draws nothing is framed on its bones.
    if (boxes.length === 0) for (const b of bones) boxes.push({ x: Math.min(b.from[0], b.to[0]), y: Math.min(b.from[1], b.to[1]), w: Math.abs(b.to[0] - b.from[0]) || 1e-3, h: Math.abs(b.to[1] - b.from[1]) || 1e-3 });
    const ref = withReference && anim?.reference && referenceIndexAt(anim.reference, frame) !== null ? anim.reference : undefined;
    if (ref) boxes.push(referenceRect(ref));
    const view = imageFrame(boxes, RENDER_SIDE);
    const marks: BoneMark[] = bones.map((b) => ({ name: b.name, from: view.toPixel(...b.from), to: view.toPixel(...b.to) }));
    const inside = (p: [number, number]) => p[0] >= 0 && p[1] >= 0 && p[0] <= view.width && p[1] <= view.height;
    const image = await this.needVision().render({ symbol: this.sym, animation: anim, frame, view, reference: !!ref, bones: withBones ? marks : [] });
    const [lx, ly] = view.fromPixel(0, 0);
    return {
      animation: anim?.name ?? null, frame,
      size: [view.width, view.height],
      reference: ref ? `image ${referenceIndexAt(ref, frame)! + 1} behind the skeleton, half transparent` : "none",
      // Pixel (px, py) from the top-left of the picture, in the skeleton's
      // space as get_pose reports it (y up).
      mapping: `x = ${round(lx, 3)} + px/${round(view.scale, 6)}, y = ${round(-ly, 3)} - py/${round(view.scale, 6)}`,
      bones: Object.fromEntries(marks.map((m) => [m.name, {
        origin: m.from.map((v) => round(v, 1)), tip: m.to.map((v) => round(v, 1)), ...(inside(m.from) ? {} : { outside: true }),
      }])),
      note: "Names that would overlap are left off the picture; every bone is listed here. Bones marked outside are beyond the picture's edges.",
      [IMAGES_KEY]: [image],
    };
  }

  /** The pose at `frame`: what it draws (the framing boxes) and every bone
   *  as a line, in the symbol's own space. */
  private frameView(anim: Animation | null, frame: number): { boxes: Rect[]; bones: Array<{ name: string; from: [number, number]; to: [number, number] }> } {
    const mode = anim ? "animate" : "setup";
    const pose = posedSymbol(this.store.project, this.sym, anim, frame, mode);
    const when: FrameContext = { animationName: anim?.name ?? null, frame, mode };
    const boxes: Rect[] = [];
    for (const e of pose.entries) {
      if (!e.visible || !(e.display || e.spine)) continue;
      const b = entryBox(this.store.project, e, when);
      if (!b) continue;
      const c = transformCorners(e.world, b);
      const xs = c.map((p) => p.x), ys = c.map((p) => p.y);
      boxes.push({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
    }
    const bones = this.bones().map((n) => {
      const m = pose.byNode.get(n.id)?.world;
      if (!m) return null;
      const tip = apply(pt(), m, n.boneLength ?? 0, 0);
      return { name: n.name, from: [m.tx, m.ty] as [number, number], to: [tip.x, tip.y] as [number, number] };
    }).filter((b): b is NonNullable<typeof b> => !!b);
    return { boxes, bones };
  }

  /** Frames rendered in ONE shared framing, so the pictures compare —
   *  per-frame framing would zoom each pose to itself. Not an AI tool: the
   *  Poses panel's thumbnails and its Ask AI handoff. `each` sees every
   *  picture as it is done — a strip shows itself progressively. */
  async renderPoses(animName: string, frames: number[], style: PoseStyle = "both", each?: (image: AgentImage, index: number) => void): Promise<AgentImage[]> {
    const anim = this.animation(animName);
    const views = frames.map((f) => this.frameView(anim, f));
    const boxes = views.flatMap((v) => v.boxes);
    if (boxes.length === 0) for (const v of views) for (const b of v.bones) {
      boxes.push({ x: Math.min(b.from[0], b.to[0]), y: Math.min(b.from[1], b.to[1]), w: Math.abs(b.to[0] - b.from[0]) || 1e-3, h: Math.abs(b.to[1] - b.from[1]) || 1e-3 });
    }
    const view = imageFrame(boxes, RENDER_SIDE);
    const images: AgentImage[] = [];
    for (let i = 0; i < frames.length; i++) {
      const marks = views[i]!.bones.map((b) => ({ name: b.name, from: view.toPixel(...b.from), to: view.toPixel(...b.to) }));
      const image = await this.needVision().render({
        symbol: this.sym, animation: anim, frame: frames[i]!, view, reference: false,
        bones: style === "artwork" ? [] : marks,
        artwork: style !== "bones",
      });
      images.push(image);
      each?.(image, i);
    }
    return images;
  }

  private needVision(): AgentVision {
    if (!this.vision) throw new AgentError("Pictures need the editor page; this host cannot draw them.");
    return this.vision;
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

function easeName(t: TweenSpec): string | number[] {
  return t.kind === "none" ? "hold" : t.kind === "linear" ? "linear"
    : t.kind === "ease" ? (t.value < 0 ? "in" : t.value <= 1 ? "out" : "inout")
    : t.kind === "curve" && t.curve.length === 4 ? t.curve.map((v) => round(v)) : "custom";
}

/** The tools' per-property names: each is the editor's channel of that name. */
const AXES = ["x", "y", "rotation", "scaleX", "scaleY"] as const;
type AxisName = typeof AXES[number];

/** A key's properties that do not follow its `ease`, with theirs. */
function axisEases(k: Keyframe): Record<string, string | number[]> | null {
  if (k.tween.kind === "none") return null;
  const out: Record<string, string | number[]> = {};
  for (const ax of AXES) {
    const e = easeOf(k, ax);
    if (!sameEase(e, k.tween)) out[ax] = easeName(e);
  }
  return Object.keys(out).length ? out : null;
}

function easesOf(raw: unknown, where: string): ChannelEases | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new AgentError(`${where}: eases is an object, e.g. {"y": "out"}.`);
  const out: ChannelEases = {};
  for (const [ax, ease] of Object.entries(raw)) {
    if (!(AXES as readonly string[]).includes(ax)) throw new AgentError(`${where}: eases has no property "${ax}" (${AXES.join(", ")}).`);
    const spec = tweenOf(ease as string | number[]);
    if (spec.kind === "none") throw new AgentError(`${where}: "hold" is for the whole key (ease), not one property.`);
    out[ax as AxisName] = spec;
  }
  return Object.keys(out).length ? out : null;
}

function point(v: unknown, where: string): SpinePoint {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) throw new AgentError(`${where} is two numbers, [x, y].`);
  return [v[0] as number, v[1] as number];
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
