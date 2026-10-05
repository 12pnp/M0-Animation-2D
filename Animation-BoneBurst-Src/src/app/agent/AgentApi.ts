import { CONSTRAINT_CHANNELS, channelKeysOf, keyedConstraint, withChannelKeys, withValueKey } from "@/core/doc/constraintKeys";
import { INHERIT_MODES, isInherit, withInheritKey } from "@/core/doc/inherit";
import type { BoneBurstInherit } from "@/core/boneburst/types";
import { changedProps, KEY_GROUPS, type KeyGroup, keyProps } from "@/core/doc/keyButtons";
import { offsetPlan, offsetTrack } from "@/core/doc/offset";
import { constraintEntries, orderFrom } from "@/core/doc/constraintOrder";
import type { Store } from "@/app/Store";
import { drawingLayers, orderAt, reorderTargets, withDrawOrderKey, withFront } from "@/core/doc/drawOrder";
import { type AnimId, type AssetId, type CnId, type IkId, type ItemId, newIkId, newTcId, type NodeId, type TcId } from "@/core/doc/ids";
import { displayAt, displaysOf, linkableDisplays, withDisplayTint, withLink } from "@/core/doc/displays";
import { skinnedOutline, withPointOffset } from "@/core/doc/boxes";
import { type Animation, type EventDef, type EventKey, type IkConstraint, type IkKey, type ImageItem, type InheritKey, type ValueKey, isImage, type TcKey, type TransformConstraint, type Keyframe, type Node, type SymbolItem, TIMELINE_PROPS, type TimelineProp, type Track } from "@/core/doc/types";
import { entryBox, type FrameContext } from "@/core/doc/pose";
import { type ImageFrame, imageFrame, referenceEnd, referenceFrameOf, referenceIndexAt, referenceRect } from "@/core/doc/reference";
import { apply } from "@/core/math/Matrix2D";
import { pt, type Rect, transformCorners } from "@/core/math/geom";
import { createKeyframe, createLayer, createNode } from "@/core/doc/defaults";
import { ikChain, ikRoles } from "@/core/doc/ikGraph";
import { boneSide, guessRoles, type MotionClip, type RigBone, retarget } from "@/core/rig/motion";
import MOTIONS from "@/core/rig/motions.json";
import BVH_MOTIONS from "@/core/rig/motions-bvh.json";
import { insertKeyframe, keyIndexAt, setEndFrame } from "@/core/doc/timeline";
import { AddAnimation, EditTracks, SetCycle, SetDrawOrder, SetEventKeys, SetEvents, SetIkKeys } from "@/core/history/timelineCommands";
import { renamedEvent, withEventDefValues, withEventKey, withEventKeyValues, withoutEvent } from "@/core/doc/events";
import { deleteTcKeys, tcMixAt, tcTweenOf, transformPlan, usedMixes, withMapping, withoutMapping, withSourceOffset, withTcKey, withTcTween } from "@/core/doc/transformKeys";
import { SetTcKeys, SetTransforms } from "@/core/history/transformCommands";
import { doBindMesh, doMakeMesh } from "@/app/MeshOps";
import type { AssetStore } from "@/app/AssetStore";
import { TC_CHANNELS, type TcChannel } from "@/core/doc/types";
import { deleteIkKeys, ikPoseAt, type IkTween, ikTweenOf, withIkKey, withIkTween } from "@/core/doc/ikKeys";
import { cyclePlan, isCycle, SEAM_TOLERANCE, seamFrame, seamGap } from "@/core/doc/cycle";
import { bonePaths, keyedIn, pathFrames } from "@/core/doc/bonePath";
import { easesToSpline, type Spline, straightSpline, withSpline } from "@/core/doc/pathSpline";
import { pathDragMode } from "@/core/doc/pathEdit";
import { AddNode, createsCycle, RenameNode, SetLayerOrder, SetParent, SetPivot, SetStageSkins } from "@/core/history/commands";
import { AddIkConstraint, SetIkOptions } from "@/core/history/ikCommands";
import { autoRigPlan, jointNames, type RigLayer } from "@/core/rig/autoRig";
import { evaluateSymbol } from "@/core/doc/pose";
import { boneFromWorld, placeOnBone, siblingOrder, type BoneBurstPoint } from "@/core/rig/rigPlan";
import type { ChannelEases, TweenSpec } from "@/core/math/easing";
import { CURVE_Y_LIMIT, easeOf, sameEase } from "@/core/math/easing";
import { applySkins, doSetSkinImage, doSetSkinMembers, doSetSkinOnly } from "@/app/SkinOps";
import { withNewSkin, withSkinColor } from "@/core/doc/skins";
import { doAddAttachment, doAddPhysics, doAddSlider, doMakePath, doMakeSequence, doSetConstraints, editShownOutline } from "@/app/AttachmentOps";
import { PHYSICS_DEFAULTS, PHYSICS_SETTINGS, SLIDER_PROPERTIES } from "@/core/doc/constraints";
import { SEQUENCE_MODES, withSequenceKey } from "@/core/doc/sequence";
import { EditNode, SetConstraintKeys, SetConstraintOrder, SetInheritKeys, SetSequenceKeys } from "@/core/history/attachmentCommands";
import type { SequenceKey } from "@/core/doc/types";
import { posedSymbol, skinsOf, stageSkinOf } from "@/core/boneburst/boneburstPose";
import { exportBoneBurst } from "@/core/boneburst/exportBoneBurst";
import { fromBoneBurstLocal, type BoneBurstLocal, toBoneBurstLocal } from "@/core/boneburst/transform";
import TOOLS from "./tools.json";

/**
 * The editor as tools an AI can call (`tools.json`): read the rig, its keys
 * and the pose the runtime draws; key bones, make animations, undo. Every
 * edit is ONE command through the Store's history, labelled "AI: …", so it
 * undoes like a manual one and the History panel shows who made it.
 *
 * Values are Spine's (x right, y UP, degrees counter-clockwise, local to
 * the parent bone): the rigs are Spine rigs, and a model knows Spine's
 * conventions better than the editor's Flash ones. `toBoneBurstLocal` /
 * `fromBoneBurstLocal` convert, exactly.
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

/** A bone's path drawn over a picture, in pixels: one point per frame, the
 *  keyed ones marked, `closed` for a cycle. */
export interface PathMark { name: string; points: Array<[number, number]>; keys: boolean[]; closed: boolean; current: number }

/** A bone drawn over a picture: from its origin to its tip, in pixels, and
 *  its side by name (`boneSide`). */
export interface BoneMark { name: string; from: [number, number]; to: [number, number]; side?: "near" | "far" }

/** What the model can look at: the page's canvases (`view/agent/AgentVision.ts`).
 *  The geometry is worked out here; this only paints and encodes. */
export interface AgentVision {
  /** One reference image, its longer side at most `maxSide` pixels. */
  image(assetId: AssetId, maxSide: number): Promise<AgentImage>;
  /** The symbol at a frame as the stage draws it, through `view`, over its
   *  reference image when `reference` is set, with `bones` marked and named.
   *  `artwork: false` leaves the pictures out and shows only the bones. */
  render(req: { symbol: SymbolItem; animation: Animation | null; frame: number; view: ImageFrame; reference: boolean; bones: BoneMark[]; artwork?: boolean; paths?: PathMark[] }): Promise<AgentImage>;
}

/** How a pose is captured (`renderPoses`): the bones alone, the artwork
 *  alone, or one over the other. */
export type PoseStyle = "bones" | "artwork" | "both";

/** Longest side of a rendered frame and of a reference image, in pixels:
 *  enough to see a pose, few enough tokens to look at many. */
const RENDER_SIDE = 768, REFERENCE_SIDE = 512, MAX_IMAGES = 6;

/** The hand-made clips (`scripts/buildMotions.ts`), then mocap converted from BVH
 *  (`scripts/buildBvhMotions.ts`, AnimatedDrawings' example takes). */
export const MOTION_CLIPS = [...MOTIONS, ...BVH_MOTIONS] as unknown as MotionClip[];

type Args = Record<string, unknown>;
type BoneIn = { name: string; parent?: string; from?: number[]; to?: number[]; x?: number; y?: number; rotation?: number; length?: number };
type AttachIn = { bone: string; image?: string; layer?: string; name?: string; pivot?: number[]; at?: number[]; rotation?: number; scale?: number };
type PathKeyIn = { frame: number; x: number; y: number; out?: number[]; in?: number[] };
type SpineKeyIn = {
  bone: string; frame: number; x?: number; y?: number; rotation?: number; scaleX?: number; scaleY?: number;
  ease?: string | number[]; eases?: Partial<Record<AxisName, string | number[]>>;
};

// + 0: no -0 in what the model reads.
const round = (v: number, digits = 4) => Math.round(v * 10 ** digits) / 10 ** digits + 0;

export class AgentApi {
  constructor(
    private readonly store: Store, private readonly preview?: PreviewProbe, private readonly vision?: AgentVision,
    /** The images' pixels, for a mesh's outline; without, a mesh is the image's rectangle. */
    private readonly assets?: AssetStore,
  ) {}

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
      case "render_frame": return this.renderFrame(typeof args.animation === "string" ? args.animation : null, args.frame === undefined ? 0 : int(args, "frame", 0), args.reference !== false, args.bones !== false, args.paths);
      case "add_bones": return this.addBones(list<BoneIn>(args, "bones"));
      case "attach": return this.attach(list<AttachIn>(args, "items"));
      case "add_ik": return this.addIk(str(args, "bone"), args);
      case "auto_rig": return this.autoRig(args);
      case "list_motions": return this.listMotions();
      case "apply_motion": return this.applyMotion(str(args, "motion"), args);
      case "draw_order": return this.drawOrder(typeof args.parent === "string" ? args.parent : null, list<string>(args, "front"));
      case "set_cycle": return this.setCycle(str(args, "animation"), args.on);
      case "key_properties": return this.keyProperties(str(args, "animation"), int(args, "frame", 0), list<string>(args, "layers"), args.properties);
      case "offset_keys": return this.offsetKeys(str(args, "animation"), list<string>(args, "layers"), int(args, "frames", 0), args.stagger === true);
      case "key_draw_order": return this.keyDrawOrder(str(args, "animation"), int(args, "frame", 0), args);
      case "key_ik": return this.keyIk(str(args, "animation"), str(args, "ik"), int(args, "frame", 0), args);
      case "define_event": return this.defineEvent(str(args, "name"), args);
      case "add_transform_constraint": return this.addTransform(args);
      case "make_mesh": return this.makeMeshes(list<string>(args, "images"), args.spacing);
      case "bind_mesh": return this.bindMesh(str(args, "image"), list<string>(args, "bones"));
      case "add_skin": return this.addSkin(str(args, "name"));
      case "add_attachment": return this.addAttachment(args);
      case "make_sequence": return this.makeSequence(str(args, "layer"));
      case "add_physics": return this.addPhysics(str(args, "bone"), args);
      case "add_slider": return this.addSlider(str(args, "animation"), args);
      case "make_path": return this.makePath(list<string>(args, "bones"));
      case "link_mesh": return this.linkMesh(str(args, "layer"), str(args, "image"), args);
      case "key_constraint": return this.keyConstraint(str(args, "animation"), str(args, "constraint"), str(args, "channel"), int(args, "frame", 0), args);
      case "set_inherit": return this.setInherit(str(args, "bone"), args);
      case "set_point": return this.setPoint(str(args, "point"), args);
      case "set_tint": return this.setTint(str(args, "layer"), args);
      case "map_transform": return this.mapTransform(str(args, "constraint"), args);
      case "set_skin_color": return this.setSkinColor(str(args, "skin"), args.color);
      case "set_constraint_order": return this.setConstraintOrder(list<string>(args, "order"));
      case "key_sequence": return this.keySequence(str(args, "animation"), str(args, "layer"), int(args, "frame", 0), args);
      case "set_skin_image": return this.setSkinImage(args);
      case "set_skin_members": return this.setSkinMembers(args);
      case "key_transform": return this.keyTransform(str(args, "animation"), str(args, "constraint"), int(args, "frame", 0), args);
      case "key_event": return this.keyEvent(str(args, "animation"), int(args, "frame", 0), str(args, "event"), args);
      case "get_bone_path": return this.getBonePath(str(args, "animation"), str(args, "bone"), args.point);
      case "set_bone_path": return this.setBonePath(str(args, "animation"), str(args, "bone"), list<PathKeyIn>(args, "keys"));
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
        setup: spine(toBoneBurstLocal(n.bind)),
        ...(n.inherit ? { inherit: n.inherit } : {}),
      })),
      slots: s.layers.map((l) => s.nodes[l.nodeId]).filter((n): n is Node => !!n && (n.kind === "image" || n.kind === "symbol"))
        .reverse().map((n) => ({ name: n.name, bone: nameOf(n.slotBone) ?? n.name, ...picture(n) })),
      ik: s.ik.map((k) => {
        const effector = s.nodes[k.boneId];
        const bones = k.chain > 0 && effector?.parentId ? [nameOf(effector.parentId), effector.name] : [effector?.name];
        return { name: k.name, bones, target: nameOf(k.targetId), mix: k.weight, ...(k.softness ? { softness: round(k.softness, 3) } : {}) };
      }),
      ...(s.events?.length ? { events: s.events.map((d) => ({ ...d })) } : {}),
      ...(s.transforms?.length ? {
        transforms: s.transforms.map((k) => ({
          name: k.name, source: nameOf(k.sourceId), bones: k.boneIds.map((id) => nameOf(id)),
          mix: Object.fromEntries(usedMixes(k).map((c) => [c, round(k.mix[c], 3)])),
          ...(k.offsets && Object.keys(k.offsets).length ? { offsets: k.offsets } : {}),
          ...(k.localSource ? { localSource: true } : {}), ...(k.localTarget ? { localTarget: true } : {}),
          ...(k.additive ? { relative: true } : {}), ...(k.clamp ? { clamp: true } : {}),
        })),
      } : {}),
      ...(constraintEntries(s).length > 1 ? { constraintOrder: constraintEntries(s).map((e) => e.name) } : {}),
      animations: s.animations.map((a) => ({
        name: a.name, frames: this.frames(a), loops: a.playTimes === 0,
        ...(a.reference ? { reference: { images: a.reference.frames.length, frames: [referenceFrameOf(a.reference, 0), referenceEnd(a.reference)] } } : {}),
      })),
      ...(skinsOf(s).some((n) => n !== "default") ? { skins: skinsOf(s).filter((n) => n !== "default") } : {}),
      images: this.libraryImages().map((i) => ({ name: i.name, width: i.width, height: i.height })),
      showing: { animation: anim?.name ?? null, frame: this.store.ui.frame, ...(skinsOf(s).some((n) => n !== "default") ? { skins: stageSkinOf(s) } : {}) },
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
        return { frame: k.frame, ...spine(toBoneBurstLocal(k.transform)), ease: easeName(k.tween), ...(own ? { eases: own } : {}) };
      });
    }
    const seam = this.seamOf(anim);
    return { name: anim.name, frames: this.frames(anim), loops: anim.playTimes === 0, cycle: isCycle(anim), ...(seam ? { seam } : {}), fps: this.store.project.frameRate, bones,
      ...(anim.poses?.length ? { poses: [...anim.poses], note: "poses: the user's key-pose frames, already keyed — keep them as they are" } : {}),
      ...(anim.drawOrder?.length ? {
        drawOrder: anim.drawOrder.map((k) => ({
          frame: k.frame,
          frontToBack: k.order ? [...orderAt(this.sym, anim, k.frame)].reverse().map((id) => this.sym.nodes[id]!.name) : "setup",
        })),
      } : {}),
      ...(anim.events?.length ? { events: anim.events.map((k) => ({ ...k })) } : {}),
      ...(anim.transforms && Object.keys(anim.transforms).length ? {
        transforms: Object.fromEntries((this.sym.transforms ?? []).filter((k) => anim.transforms?.[k.id]?.length).map((k) => [k.name, anim.transforms![k.id]!.map((key) => ({
          frame: key.frame, mix: Object.fromEntries(usedMixes(k).map((c) => [c, round(key.mix[c], 3)])), ease: tcTweenOf(key),
        }))])),
      } : {}),
      ...(anim.ik && Object.keys(anim.ik).length ? {
        ik: Object.fromEntries(this.sym.ik.filter((k) => anim.ik?.[k.id]?.length).map((k) => [k.name, anim.ik![k.id]!.map((key) => ({
          frame: key.frame, ...ikKeyOut(k, key),
        }))])),
      } : {}) };
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
      const now = toBoneBurstLocal(key.transform);
      const next: BoneBurstLocal = { ...now };
      for (const ch of ["x", "y", "rotation", "scaleX", "scaleY"] as const) {
        const v = k[ch];
        if (v === undefined) continue;
        if (typeof v !== "number" || !Number.isFinite(v)) throw new AgentError(`Key for "${k.bone}" at ${k.frame}: ${ch} must be a number.`);
        next[ch] = v;
      }
      const patch: Partial<Keyframe> = { transform: fromBoneBurstLocal(next) };
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
    return { showing: anim.name, frame: this.store.ui.frame, ...(skinsOf(this.sym).some((n) => n !== "default") ? { skins: stageSkinOf(this.sym) } : {}) };
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
          const placed = boneFromWorld(parent ? this.setupWorld(parent.id) : undefined, b.from as unknown as BoneBurstPoint, b.to as unknown as BoneBurstPoint);
          if (!placed) throw new AgentError(`Bone "${b.name}": its parent "${b.parent}" is scaled to nothing.`);
          node.bind = placed.bind;
          node.boneLength = Math.max(1, round(placed.length, 2));
        } else {
          node.bind = fromBoneBurstLocal({ x: b.x ?? 0, y: b.y ?? 0, rotation: b.rotation ?? 0, shearX: 0, shearY: 0, scaleX: 1, scaleY: 1 });
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
      const at: BoneBurstPoint = it.at === undefined ? [boneWorld?.tx ?? 0, -(boneWorld?.ty ?? 0)] : point(it.at, `"${name}": at`);
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
    for (const f of ["stretch", "compress"]) if (args[f] !== undefined && typeof args[f] !== "boolean") throw new AgentError(`${f} is true or false.`);
    if (args.scale_y !== undefined && !["none", "uniform", "volume"].includes(args.scale_y as string)) throw new AgentError(`scale_y is "none", "uniform" or "volume".`);

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
        ...(args.stretch === true ? { stretch: true } : {}), ...(args.compress === true ? { compress: true } : {}),
        ...(args.scale_y === "uniform" || args.scale_y === "volume" ? { scaleY: args.scale_y } : {}),
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

  /* ── auto rig ── */

  private autoRig(args: Args) {
    const view = args.view ?? "side";
    if (view !== "side" && view !== "front") throw new AgentError(`view is "side" or "front".`);
    const facing = args.facing ?? "right";
    if (facing !== "right" && facing !== "left") throw new AgentError(`facing is "right" or "left".`);
    if (!args.joints || typeof args.joints !== "object" || Array.isArray(args.joints)) throw new AgentError(`joints is an object of name → [x, y] in skeleton space. Joints: ${jointNames(view).join(", ")}.`);
    const s = this.sym;
    const setup = posedSymbol(this.store.project, s, null, 0, "setup");
    const wanted = Array.isArray(args.layers) ? new Set(args.layers.map(String)) : null;
    // Pictures not on a bone yet, front first.
    const layers: RigLayer[] = [];
    s.layers.forEach((l, z) => {
      const n = s.nodes[l.nodeId];
      if (!n || n.kind !== "image" || n.slotBone || n.parentId || !n.itemId) return;
      if (wanted && !wanted.has(n.name)) return;
      const item = this.store.project.items[n.itemId], m = setup.byNode.get(n.id)?.world;
      if (!item || !isImage(item) || !m) return;
      layers.push({ name: n.name, size: [item.width, item.height], pivot: [n.pivot.x, n.pivot.y], at: [m.tx, -m.ty], rotation: (Math.atan2(-m.b, m.a) * 180) / Math.PI, z });
    });
    if (wanted) for (const name of wanted) if (!layers.some((l) => l.name === name)) throw new AgentError(`"${name}" is not a picture layer off any bone.`);
    const plan = autoRigPlan(args.joints as Record<string, [number, number]>, layers, view, { armIk: args.armIk === true, taken: (n) => this.nameTaken(n) });
    if (typeof plan === "string") throw new AgentError(plan);
    const existing = Object.values(s.nodes).find((n) => n.kind === "bone" && ["hips", "torso"].includes(n.name.replace(/_bone\d*$/, "")));
    if (existing) throw new AgentError(`The rig already has "${existing.name}": auto_rig builds a skeleton from nothing. Undo the old one first.`);

    const before = this.store.history.position;
    try {
      this.store.transaction("AI: Auto Rig", () => {
        this.addBones(plan.bones.map((b) => ({ name: b.name, ...(b.parent ? { parent: b.parent } : {}), from: [...b.from], to: [...b.to] })));
        if (plan.attach.length) this.attach(plan.attach.map((a) => ({ bone: a.bone, layer: a.layer, pivot: a.pivot })));
        for (const o of plan.order) this.drawOrder(o.parent, o.front);
        for (const bone of plan.ik) {
          this.addIk(bone, {});
          const chain = plan.bones.filter((b) => b.name === bone || plan.bones.find((x) => x.name === bone)?.parent === b.name);
          this.settleBend(bone, chain, view === "side" ? facing : null);
        }
      });
    } catch (err) {
      // A step that failed half way is not left behind.
      if (this.store.history.position > before) this.store.undo();
      throw err;
    }

    // The setup pose now, against the joints it was built from.
    const posed = posedSymbol(this.store.project, this.sym, null, 0, "setup");
    let worst = 0, at = "";
    for (const b of plan.bones) {
      const m = posed.byNode.get(this.bone(b.name).id)?.world;
      const d = m ? Math.hypot(m.tx - b.from[0], -m.ty - b.from[1]) : Infinity;
      if (d > worst) { worst = d; at = b.name; }
    }
    return {
      bones: plan.bones.map((b) => b.name),
      attached: plan.attach.map((a) => ({ layer: a.layer, bone: a.bone })),
      ik: plan.ik.map((b) => `${b}_ik`),
      check: { matches: worst < 0.5, worstPixels: round(worst, 3), ...(worst < 0.5 ? {} : { at }) },
      notes: plan.notes,
      next: "Look with render_frame (no animation). Move a layer to another bone with attach; for a wrong joint, undo and run auto_rig again.",
    };
  }

  /**
   * Which way an IK chain bends: as drawn when the joint is visibly bent,
   * otherwise a knee forward and an elbow back for a side view facing
   * `facing`. Probed by pulling the target in on a copy of the symbol and
   * solving: the solver's choice is not guessable from `bendPositive`
   * alone (ARCHITECTURE ▸ Bones and IK).
   */
  private settleBend(effectorName: string, chain: Array<{ name: string; from: BoneBurstPoint; to: BoneBurstPoint }>, facing: "right" | "left" | null): void {
    const s = this.sym;
    const k = s.ik.find((x) => s.nodes[x.boneId]?.name === effectorName);
    const ids = k ? ikChain(s, k) : [];
    if (!k || ids.length !== 2 || chain.length !== 2) return;
    const angle = (b: { from: BoneBurstPoint; to: BoneBurstPoint }) => Math.atan2(b.to[1] - b.from[1], b.to[0] - b.from[0]);
    const [root, eff] = ids.map((id) => chain.find((c) => c.name === s.nodes[id]!.name)!);
    const drawn = Math.sin(angle(eff!) - angle(root!));
    // Turn sign root → effector, y up: a knee forward bends a right-facing leg clockwise.
    const leg = /^shin_/.test(effectorName);
    const want = Math.abs(drawn) > 0.05 ? Math.sign(drawn) : facing ? (leg ? -1 : 1) * (facing === "right" ? 1 : -1) : 0;
    if (!want) return;
    const pose = evaluateSymbol(s, null, 0, "setup");
    const target = s.nodes[k.targetId]!, tw = pose.byNode.get(target.id)?.world, rw = pose.byNode.get(ids[0]!)?.world;
    if (!tw || !rw) return;
    const parentWorld = target.parentId ? pose.byNode.get(target.parentId)?.world : undefined;
    const pulled = placeOnBone(parentWorld, [tw.tx + 0.25 * (rw.tx - tw.tx), -(tw.ty + 0.25 * (rw.ty - tw.ty))]);
    if (!pulled) return;
    const probe = evaluateSymbol({ ...s, nodes: { ...s.nodes, [target.id]: { ...target, bind: pulled } } }, null, 0, "setup");
    const [a, b] = ids.map((id) => probe.byNode.get(id)!.world);
    const got = Math.sign(Math.sin(Math.atan2(-b!.b, b!.a) - Math.atan2(-a!.b, a!.a)));
    if (got !== want) this.store.apply(new SetIkOptions(this.store.currentSymbolId, k.id, { bendPositive: !k.bendPositive }));
  }

  /* ── motions ── */

  /** Bones a clip may move: real bones, not IK targets. */
  private motionBones(): Node[] {
    const { targets } = ikRoles(this.sym);
    return this.bones().filter((n) => n.kind === "bone" && !targets.has(n.id));
  }

  private listMotions() {
    const names = this.motionBones().map((n) => n.name);
    return {
      motions: MOTION_CLIPS.map((c) => ({ name: c.name, description: c.description, view: c.view, frames: c.frames, fps: c.fps, roles: Object.keys(c.angles) })),
      guess: { side: guessRoles(names, "side").map, front: guessRoles(names, "front").map },
      note: "apply_motion maps roles to bones by these guesses unless you give map; check them against get_rig.",
    };
  }

  private applyMotion(motion: string, args: Args) {
    const clip = MOTION_CLIPS.find((c) => c.name === motion);
    if (!clip) throw new AgentError(`There is no motion "${motion}". list_motions lists them.`);
    const name = typeof args.animation === "string" ? args.animation : motion;
    if (this.sym.animations.some((a) => a.name === name)) throw new AgentError(`There is already an animation "${name}": give another name.`);
    const facing = args.facing ?? "right";
    if (facing !== "right" && facing !== "left") throw new AgentError(`facing is "right" or "left".`);
    const fps = this.store.project.frameRate;
    const frames = args.frames === undefined ? Math.max(1, Math.round((clip.frames * fps) / clip.fps)) : int(args, "frames", 1);

    const guess = guessRoles(this.motionBones().map((n) => n.name), clip.view);
    const map: Record<string, string> = { ...guess.map };
    if (args.map !== undefined) {
      if (!args.map || typeof args.map !== "object" || Array.isArray(args.map)) throw new AgentError(`map is an object of role → bone, e.g. {"thigh.near": "leg_l_up"}.`);
      for (const [role, bone] of Object.entries(args.map)) {
        if (bone === null) { delete map[role]; continue; }
        if (typeof bone !== "string") throw new AgentError(`map.${role} is a bone name, or null to leave the role out.`);
        if (this.bone(bone).kind !== "bone") throw new AgentError(`"${bone}" is a slot; map roles to bones.`);
        map[role] = bone;
      }
    }
    if (Object.keys(map).length === 0) throw new AgentError("No bone is mapped to a role; give map (list_motions lists the roles).");

    const s = this.sym;
    const setup = posedSymbol(this.store.project, s, null, 0, "setup");
    const rig: RigBone[] = this.bones().map((n) => {
      const m = setup.byNode.get(n.id)?.world;
      return {
        name: n.id, parent: n.parentId && s.nodes[n.parentId] ? n.parentId : null, local: toBoneBurstLocal(n.bind), length: n.boneLength ?? 0,
        setup: m ? { x: m.tx, y: -m.ty, rotation: (Math.atan2(-m.b, m.a) * 180) / Math.PI, scaleX: Math.hypot(m.a, m.b) } : { x: 0, y: 0, rotation: 0, scaleX: 1 },
      };
    });
    const idOf = (bone: string) => this.bone(bone).id as string;
    const nameOf = (id: string) => s.nodes[id as NodeId]?.name ?? id;
    let result;
    try {
      result = retarget({
        clip, bones: rig, frames, facing,
        map: Object.fromEntries(Object.entries(map).map(([role, bone]) => [role, idOf(bone)])),
        ik: s.ik.map((k) => {
          const chain = ikChain(s, k);
          // Which way the solver bends it, read off the solved setup pose.
          const [r, e] = chain.map((id) => setup.byNode.get(id)?.world);
          const turn = r && e ? Math.sin(Math.atan2(-e.b, e.a) - Math.atan2(-r.b, r.a)) : 0;
          return { bones: chain as string[], target: k.targetId as string, ...(chain.length === 2 && Math.abs(turn) > 0.02 ? { bend: turn > 0 ? 1 as const : -1 as const } : {}) };
        }),
      });
    } catch (err) {
      throw new AgentError(err instanceof Error ? err.message.replace(/"([^"]+)"/g, (_, id: string) => `"${nameOf(id)}"`) : String(err));
    }

    const label = `AI: Motion "${clip.name}" as "${name}"`;
    this.store.transaction(label, () => {
      this.newAnimation(name, frames);
      this.setKeys(name, result.keys.map((k) => ({ ...k, bone: nameOf(k.bone), ease: "linear" })));
    });

    // What the runtime now shows, against what the retarget posed.
    const anim = this.animation(name);
    let worstDeg = 0, worstPx = 0, at = "";
    for (const e of result.expected) {
      const pose = posedSymbol(this.store.project, s, anim, e.frame, "animate");
      for (const [id, want] of Object.entries(e.bones)) {
        const m = pose.byNode.get(id as NodeId)?.world;
        if (!m) continue;
        const deg = Math.abs(((((Math.atan2(-m.b, m.a) * 180) / Math.PI - want.rotation) % 360) + 540) % 360 - 180);
        const px = Math.hypot(m.tx - want.x, -m.ty - want.y);
        if (deg > worstDeg) { worstDeg = deg; at = `"${nameOf(id)}" at frame ${e.frame}`; }
        worstPx = Math.max(worstPx, px);
      }
    }
    const matches = worstDeg < 1 && worstPx < 1;
    return {
      animation: name, frames, motion: clip.name, facing, cycle: isCycle(this.animation(name)),
      map: Object.fromEntries(Object.entries(map).sort()),
      keys: result.keys.length,
      ...(result.ground !== undefined ? { ground: round(result.ground, 2) } : {}),
      check: { matches, worstDegrees: round(worstDeg, 3), worstPixels: round(worstPx, 3), ...(matches ? {} : { at, hint: "An IK chain may bend the other way (add_ik's bendPositive), or a role is on the wrong bone: look with render_frame." }) },
      notes: [...guess.notes, ...result.notes.map((n) => n.replace(/"([^"]+)"/g, (_, id: string) => `"${nameOf(id)}"`))],
    };
  }

  /* ── cycles and paths ── */

  /** For a cycle: the bones whose pose on the last frame (frame 0 again)
   *  is not frame 0's, each where the difference starts (`seamGap`, in the
   *  parent's frame). Null for an animation that is not a cycle. */
  private seamOf(anim: Animation) {
    const join = seamFrame(anim);
    if (join === null) return null;
    const p = this.store.project;
    const names = new Map(this.bones().map((n) => [n.id, n.name]));
    const gaps = seamGap(posedSymbol(p, this.sym, anim, 0, "animate"), posedSymbol(p, this.sym, anim, join, "animate"), SEAM_TOLERANCE, true)
      .filter((g) => names.has(g.nodeId))
      .map((g) => ({
        bone: names.get(g.nodeId)!,
        ...(g.distance > SEAM_TOLERANCE.px ? { pixels: round(g.distance, 2) } : {}),
        ...(Math.abs(g.rotation) > SEAM_TOLERANCE.deg ? { degrees: round(-g.rotation, 2) } : {}),
        ...(g.scale > SEAM_TOLERANCE.scale ? { scale: round(g.scale, 4) } : {}),
        ...(g.color ? { color: true } : {}),
        ...(g.display ? { attachment: true } : {}),
      }));
    return { lastFrame: join, closes: gaps.length === 0, ...(gaps.length ? { gaps } : {}) };
  }

  private keyDrawOrder(animName: string, frame: number, args: Args) {
    const anim = this.animation(animName);
    const s = this.sym;
    let order: NodeId[] | null = null;
    if (args.setup !== true) {
      const names = list<string>(args, "front");
      if (!names.length) throw new AgentError("front lists layers, front first; or pass setup: true.");
      const front = names.flatMap((n) => reorderTargets(s, [this.node(n).id]));
      if (!front.length) throw new AgentError(`None of ${names.map((n) => `"${n}"`).join(", ")} draws anything.`);
      order = withFront(orderAt(s, anim, frame), front);
    }
    const keys = withDrawOrderKey(anim.drawOrder ?? [], frame, order, drawingLayers(s));
    this.store.apply(new SetDrawOrder(`AI: Draw Order at ${frame + 1}`, this.store.currentSymbolId, anim.id, keys));
    this.store.emit("timeline");
    this.store.emit("stage");
    const now = orderAt(s, this.animation(animName), frame);
    return { animation: anim.name, frame, frontToBack: [...now].reverse().map((id) => s.nodes[id]!.name) };
  }

  private keyIk(animName: string, ikName: string, frame: number, args: Args) {
    const anim = this.animation(animName);
    const k = this.sym.ik.find((c) => c.name === ikName);
    if (!k) throw new AgentError(`There is no IK constraint "${ikName}". get_rig lists them.`);
    if (args.mix !== undefined && (typeof args.mix !== "number" || !(args.mix >= 0 && args.mix <= 1))) throw new AgentError("mix is a number from 0 to 1.");
    if (args.bendPositive !== undefined && typeof args.bendPositive !== "boolean") throw new AgentError("bendPositive is true or false.");
    if (args.ease !== undefined && args.ease !== "linear" && args.ease !== "stepped" && args.ease !== "smooth") throw new AgentError(`ease is "linear", "stepped" or "smooth".`);
    if (args.softness !== undefined && (typeof args.softness !== "number" || !(args.softness >= 0))) throw new AgentError("softness is a number of pixels, 0 or more.");
    const before = anim.ik?.[k.id] ?? [];
    let keys: IkKey[];
    if (args.delete === true) {
      if (!before.some((key) => key.frame === frame)) throw new AgentError(`"${ikName}" has no key at frame ${frame}.`);
      keys = deleteIkKeys(before, [frame]);
    } else {
      const now = ikPoseAt(k, anim, frame);
      keys = withIkKey(before, frame, {
        mix: typeof args.mix === "number" ? args.mix : now.mix,
        bendPositive: typeof args.bendPositive === "boolean" ? args.bendPositive : now.bendPositive,
        softness: typeof args.softness === "number" ? args.softness : now.softness,
      }, k.softness);
      if (args.ease) keys = withIkTween(keys, [frame], args.ease as IkTween);
    }
    this.store.apply(new SetIkKeys(`AI: IK "${k.name}" at ${frame + 1}`, this.store.currentSymbolId, anim.id, k.id, keys));
    this.store.emit("timeline");
    this.store.emit("stage");
    return {
      animation: anim.name, ik: k.name,
      keys: keys.map((key) => ({ frame: key.frame, ...ikKeyOut(k, key) })),
    };
  }

  private makeMeshes(names: string[], spacing: unknown) {
    if (spacing !== undefined && (typeof spacing !== "number" || !(spacing >= 2))) throw new AgentError("spacing is a number of pixels, 2 or more.");
    const ids = names.map((n) => this.node(n).id);
    const made = doMakeMesh(this.store, this.assets ?? null, ids, "AI: Make Mesh", spacing as number | undefined);
    if (!made) throw new AgentError("None of those is an image of its own without a mesh.");
    return {
      meshes: ids.filter((id) => this.sym.nodes[id]?.mesh).map((id) => {
        const m = this.sym.nodes[id]!.mesh!;
        return { image: this.sym.nodes[id]!.name, points: m.points.length / 2, outline: m.hull, triangles: m.triangles.length / 3 };
      }),
    };
  }

  private bindMesh(image: string, bones: string[]) {
    const ids = [this.node(image).id, ...bones.map((n) => this.bone(n).id)];
    const refused = doBindMesh(this.store, ids, "AI: Bind Mesh");
    if (refused) throw new AgentError(refused);
    const m = this.sym.nodes[ids[0]!]!.mesh!;
    return { image, bones, points: m.points.length / 2 };
  }

  private addAttachment(args: Args) {
    const kind = args.kind;
    if (kind !== "box" && kind !== "point") throw new AgentError(`kind is "box" or "point".`);
    const on = args.on === undefined ? null : this.node(str(args, "on"));
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (name && this.nameTaken(name)) throw new AgentError(`The name "${name}" is taken.`);
    const before = new Set(Object.keys(this.sym.nodes));
    this.store.selectNodes(on ? [on.id] : []);
    this.store.transaction(kind === "box" ? "AI: Add Bounding Box" : "AI: Add Point", () => {
      doAddAttachment(this.store, this.assets ?? null, kind);
      const added = Object.values(this.sym.nodes).find((n) => !before.has(n.id))!;
      if (name) this.store.apply(new RenameNode(this.store.currentSymbolId, added.id, name));
    });
    const made = Object.values(this.sym.nodes).find((n) => !before.has(n.id))!;
    const node = this.sym.nodes[made.id]!;
    return { [kind === "box" ? "box" : "point"]: node.name, parent: node.parentId ? this.sym.nodes[node.parentId]!.name : null, ...(node.box ? { points: node.box.points.length / 2 } : {}) };
  }

  private addPhysics(boneName: string, args: Args) {
    const bone = this.bone(boneName);
    const before = new Set((this.sym.physics ?? []).map((k) => k.id));
    const settings = args.settings && typeof args.settings === "object" ? args.settings as Record<string, unknown> : {};
    for (const [k, v] of Object.entries(settings)) {
      if (!PHYSICS_SETTINGS.includes(k as never)) throw new AgentError(`"${k}" is not a physics setting; they are ${PHYSICS_SETTINGS.join(", ")}.`);
      if (typeof v !== "number" || !Number.isFinite(v)) throw new AgentError(`${k} is a number.`);
    }
    this.store.transaction("AI: Add Physics", () => {
      doAddPhysics(this.store, bone.id);
      const list = (this.sym.physics ?? []).map((k) => (before.has(k.id) ? k : { ...k, ...settings }));
      if (Object.keys(settings).length) doSetConstraints(this.store, "physics", list, "AI: Add Physics");
    });
    const made = this.sym.physics!.find((k) => !before.has(k.id))!;
    return { constraint: made.name, bone: bone.name, settings: Object.fromEntries(PHYSICS_SETTINGS.map((s) => [s, made[s] ?? PHYSICS_DEFAULTS[s]])) };
  }

  private linkMesh(layerName: string, image: string, args: Args) {
    const node = this.node(layerName);
    if (!node.mesh) throw new AgentError(`"${node.name}" is not a mesh: make_mesh first.`);
    const index = displaysOf(node).findIndex((d, i) => i > 0 && this.store.project.items[d.itemId]?.name === image);
    if (index < 0) throw new AgentError(`"${node.name}" has no other image "${image}"; its images are ${displaysOf(node).map((d) => `"${this.store.project.items[d.itemId]?.name}"`).join(", ")}.`);
    if (!linkableDisplays(node, 0).includes(index)) throw new AgentError(`"${image}" on "${node.name}" has a mesh or sequence of its own.`);
    const link = args.linked === false ? undefined : args.deform === false ? { to: 0, deform: false as const } : { to: 0 };
    this.store.apply(new EditNode(link ? `AI: Link "${image}" to "${node.name}"'s Mesh` : `AI: Unlink "${image}"`, this.store.currentSymbolId, node.id, (n) => withLink(n, index, link)));
    this.store.emit("stage");
    return { layer: node.name, image, linked: !!link, ...(link ? { deform: link.deform !== false } : {}) };
  }

  private keyConstraint(animName: string, name: string, channel: string, frame: number, args: Args) {
    const anim = this.animation(animName);
    const k = [...(this.sym.physics ?? []), ...(this.sym.sliders ?? []), ...(this.sym.paths ?? [])].find((c) => c.name === name);
    const c = k ? keyedConstraint(this.sym, k.id) : null;
    if (!c) throw new AgentError(`There is no physics, slider or path constraint "${name}". get_rig lists them.`);
    const channels = CONSTRAINT_CHANNELS[c.kind] as readonly string[];
    if (!channels.includes(channel)) throw new AgentError(`A ${c.kind} constraint keys ${channels.join(", ")}.`);
    if (args.ease !== undefined && args.ease !== "linear" && args.ease !== "stepped" && args.ease !== "smooth") throw new AgentError(`ease is "linear", "stepped" or "smooth".`);
    const before = channelKeysOf(anim, c.k.id, channel);
    let keys: ValueKey[];
    if (args.delete === true) {
      if (!before.some((x) => x.frame === frame)) throw new AgentError(`"${name}" has no ${channel} key at frame ${frame}.`);
      keys = before.filter((x) => x.frame !== frame);
    } else {
      if (typeof args.value !== "number" || !Number.isFinite(args.value)) throw new AgentError("value is a number.");
      keys = withValueKey(before, frame, args.value);
      if (args.ease) {
        const tween = args.ease === "stepped" ? { kind: "none" as const } : args.ease === "smooth" ? { kind: "curve" as const, curve: [0.42, 0, 0.58, 1] } : undefined;
        keys = keys.map((x) => {
          if (x.frame !== frame) return x;
          const { tween: _t, ...rest } = x;
          return tween ? { ...rest, tween } : rest;
        });
      }
    }
    this.store.apply(new SetConstraintKeys(`AI: Key "${name}" ${channel} at ${frame + 1}`, this.store.currentSymbolId, anim.id, withChannelKeys(anim.constraintKeys, c.k.id, channel, keys)));
    this.store.emit("timeline");
    this.store.emit("stage");
    return { constraint: name, channel, animation: anim.name, keys };
  }

  /** A point's offset and turn (Spine's point `x`, `y`, `rotation`), y down and clockwise as the stage. */
  private setPoint(name: string, args: Args) {
    const node = Object.values(this.sym.nodes).find((n) => n.name === name && n.kind === "point") ?? this.node(name);
    if (node.kind !== "point") throw new AgentError(`"${node.name}" is not a point (add_attachment makes one).`);
    const patch: Partial<NonNullable<Node["point"]>> = {};
    for (const k of ["x", "y", "rotation"] as const) {
      if (args[k] === undefined) continue;
      if (typeof args[k] !== "number" || !Number.isFinite(args[k])) throw new AgentError(`${k} is a number.`);
      patch[k] = args[k] as number;
    }
    if (!Object.keys(patch).length) throw new AgentError("Give x, y or rotation.");
    editShownOutline(this.store, node.id, (n) => withPointOffset(n, patch), `AI: Move Point "${node.name}"`);
    this.store.emit("stage");
    const p = skinnedOutline(this.sym, this.sym.nodes[node.id]!, stageSkinOf(this.sym)).point;
    return { point: node.name, x: p?.x ?? 0, y: p?.y ?? 0, rotation: p?.rotation ?? 0 };
  }

  /** A display's own colour (Spine's attachment `color`): "rrggbb" or "rrggbbaa", null for none. */
  private setTint(name: string, args: Args) {
    // An opened file's slot shares its name with its bone: the one with images.
    const node = Object.values(this.sym.nodes).find((n) => n.name === name && n.itemId) ?? this.node(name);
    const index = args.display === undefined ? 0 : int(args, "display", 0);
    if (!displayAt(node, index)) throw new AgentError(`"${node.name}" has no display ${index}.`);
    const c = args.color;
    if (c !== null && (typeof c !== "string" || !/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(c))) throw new AgentError(`color is "rrggbb" or "rrggbbaa", or null for none.`);
    const hex = typeof c === "string" ? c.replace("#", "") : null;
    const tint = hex ? (hex.length === 6 ? `${hex}ff` : hex) : undefined;
    this.store.apply(new EditNode(`AI: Tint "${node.name}"`, this.store.currentSymbolId, node.id, (n) => withDisplayTint(n, index, tint)));
    this.store.emit("stage");
    return { layer: node.name, display: index, tint: displayAt(this.sym.nodes[node.id]!, index)?.tint ?? null };
  }

  /** One mapping of a transform constraint's property map, in Spine's units. */
  private mapTransform(name: string, args: Args) {
    const k = (this.sym.transforms ?? []).find((c) => c.name === name);
    if (!k) throw new AgentError(`There is no transform constraint "${name}"; get_rig lists them.`);
    const from = args.from, to = args.to;
    if (!TC_CHANNELS.includes(from as TcChannel) || !TC_CHANNELS.includes(to as TcChannel)) throw new AgentError(`from and to are each one of ${TC_CHANNELS.join(", ")}.`);
    const patch: { scale?: number; offset?: number; max?: number } = {};
    for (const f of ["scale", "offset", "max"] as const) {
      if (args[f] === undefined) continue;
      if (typeof args[f] !== "number" || !Number.isFinite(args[f])) throw new AgentError(`${f} is a number.`);
      patch[f] = args[f] as number;
    }
    let properties = args.remove === true ? withoutMapping(k.properties, from as TcChannel, to as TcChannel) : withMapping(k.properties, from as TcChannel, to as TcChannel, patch);
    if (args.sourceOffset !== undefined) {
      if (typeof args.sourceOffset !== "number" || !Number.isFinite(args.sourceOffset)) throw new AgentError("sourceOffset is a number.");
      properties = withSourceOffset(properties, from as TcChannel, args.sourceOffset);
    }
    if (!properties.length) throw new AgentError(`That would leave "${k.name}" driving nothing; remove the constraint instead.`);
    const next = (this.sym.transforms ?? []).map((c) => (c.id === k.id ? { ...c, properties } : c));
    this.store.apply(new SetTransforms(`AI: Transform Map "${k.name}"`, this.store.currentSymbolId, next));
    this.store.emit("stage");
    return { constraint: k.name, properties };
  }

  private setInherit(boneName: string, args: Args) {
    const bone = this.bone(boneName);
    const mode = args.inherit;
    if (args.delete !== true && !isInherit(mode)) throw new AgentError(`inherit is one of ${INHERIT_MODES.join(", ")}.`);
    if (args.animation === undefined) {
      if (args.delete === true) throw new AgentError("delete removes a key: give the animation and frame.");
      this.store.apply(new EditNode(`AI: Inherit "${bone.name}"`, this.store.currentSymbolId, bone.id, (n) => {
        const out = { ...n };
        if (mode !== "normal") out.inherit = mode as BoneBurstInherit; else delete out.inherit;
        return out;
      }));
      this.store.emit("stage");
      return { bone: bone.name, inherit: mode };
    }
    const anim = this.animation(str(args, "animation"));
    const frame = int(args, "frame", 0);
    const before = anim.inherits?.[bone.id] ?? [];
    let keys: InheritKey[];
    if (args.delete === true) {
      if (!before.some((k) => k.frame === frame)) throw new AgentError(`"${bone.name}" has no inherit key at frame ${frame}.`);
      keys = before.filter((k) => k.frame !== frame);
    } else keys = withInheritKey(before, frame, mode as BoneBurstInherit);
    this.store.apply(new SetInheritKeys(`AI: Inherit "${bone.name}" at ${frame + 1}`, this.store.currentSymbolId, anim.id, bone.id, keys));
    this.store.emit("timeline");
    this.store.emit("stage");
    return { bone: bone.name, animation: anim.name, keys };
  }

  private setConstraintOrder(names: string[]) {
    const order = orderFrom(this.sym, names);
    if (typeof order === "string") throw new AgentError(`${order} get_rig lists the constraints in constraintOrder.`);
    this.store.apply(new SetConstraintOrder("AI: Constraint Order", this.store.currentSymbolId, order));
    this.store.emit("stage");
    this.store.emit("doc");
    return { constraintOrder: constraintEntries(this.sym).map((e) => e.name) };
  }

  private addSlider(animName: string, args: Args) {
    const anim = this.animation(animName);
    const bone = args.bone === undefined ? null : this.bone(str(args, "bone"));
    if (args.property !== undefined && !SLIDER_PROPERTIES.includes(args.property as never)) throw new AgentError(`property is one of ${SLIDER_PROPERTIES.join(", ")}.`);
    const before = new Set((this.sym.sliders ?? []).map((k) => k.id));
    this.store.transaction("AI: Add Slider", () => {
      doAddSlider(this.store, anim.id, bone?.id ?? null);
      const patch: Record<string, unknown> = {};
      for (const f of ["from", "to", "scale", "time", "mix"]) if (typeof args[f] === "number") patch[f] = args[f];
      for (const f of ["loop", "additive", "local"]) if (args[f] === true) patch[f] = true;
      if (bone && args.property) patch.property = args.property;
      if (Object.keys(patch).length) doSetConstraints(this.store, "sliders", (this.sym.sliders ?? []).map((k) => (before.has(k.id) ? k : { ...k, ...patch })), "AI: Add Slider");
    });
    const made = this.sym.sliders!.find((k) => !before.has(k.id))!;
    const { id: _id, animId: _a, boneId: _b, ...rest } = made;
    return { ...rest, animation: anim.name, ...(bone ? { bone: bone.name } : {}) };
  }

  private makePath(bones: string[]) {
    const ids = bones.map((n) => this.bone(n).id);
    const refused = doMakePath(this.store, ids);
    if (refused) throw new AgentError(refused);
    const k = this.sym.paths![this.sym.paths!.length - 1]!;
    return { constraint: k.name, path: this.sym.nodes[k.pathId]!.name, bones: k.boneIds.map((id) => this.sym.nodes[id]!.name), knots: this.sym.nodes[k.pathId]!.path!.points.length / 6 };
  }

  private makeSequence(layer: string) {
    const node = this.node(layer);
    const problem = doMakeSequence(this.store, node.id);
    if (problem) throw new AgentError(problem);
    const seq = this.sym.nodes[node.id]!.sequence!;
    return { layer, frames: seq.items.map((id) => this.store.project.items[id]!.name) };
  }

  private keySequence(animName: string, layer: string, frame: number, args: Args) {
    const anim = this.animation(animName);
    const node = this.node(layer);
    if (!node.sequence) throw new AgentError(`"${layer}" is not a sequence; make_sequence first.`);
    const before = anim.sequences?.[node.id] ?? [];
    let keys: SequenceKey[];
    if (args.delete === true) {
      if (!before.some((k) => k.frame === frame)) throw new AgentError(`"${layer}" has no sequence key at frame ${frame}.`);
      keys = before.filter((k) => k.frame !== frame);
    } else {
      const mode = args.mode ?? "loop";
      if (!SEQUENCE_MODES.includes(mode as never)) throw new AgentError(`mode is one of ${SEQUENCE_MODES.join(", ")}.`);
      const index = args.index === undefined ? 0 : Number(args.index);
      if (!Number.isInteger(index) || index < 0 || index >= node.sequence.items.length) throw new AgentError(`index is 0 to ${node.sequence.items.length - 1}.`);
      const delay = args.delay === undefined ? 1 : Number(args.delay);
      if (!(delay > 0)) throw new AgentError("delay is a number of frames per image, above 0.");
      keys = withSequenceKey(before, { frame, mode: mode as SequenceKey["mode"], index, delay });
    }
    this.store.apply(new SetSequenceKeys(`AI: Sequence "${layer}" at ${frame + 1}`, this.store.currentSymbolId, anim.id, node.id, keys));
    this.store.emit("timeline");
    this.store.emit("stage");
    return { animation: anim.name, layer, keys };
  }

  private skinNamed(name: string): string {
    const named = skinsOf(this.sym).filter((n) => n !== "default");
    if (!named.includes(name)) throw new AgentError(`There is no skin "${name}"; the rig has ${named.length ? named.join(", ") : "none"} (add_skin makes one).`);
    return name;
  }

  private addSkin(name: string) {
    const refused = applySkins(this.store, "AI: New Skin", withNewSkin(this.sym, name));
    if (refused) throw new AgentError(refused);
    return { skins: skinsOf(this.sym).filter((n) => n !== "default"), showing: stageSkinOf(this.sym) };
  }

  /** A skin's colour in Spine's editor: "rrggbb" or "rrggbbaa", null for Spine's default. */
  private setSkinColor(name: string, color: unknown) {
    const skin = this.skinNamed(name);
    if (color !== null && (typeof color !== "string" || !/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color))) throw new AgentError(`color is "rrggbb" or "rrggbbaa", or null for Spine's default.`);
    const hex = typeof color === "string" ? color.replace("#", "") : null;
    const refused = applySkins(this.store, `AI: Skin Colour "${skin}"`, withSkinColor(this.sym, skin, hex ? (hex.length === 6 ? `${hex}ff` : hex) : undefined));
    if (refused) throw new AgentError(refused);
    return { skin, color: this.sym.skins?.find((d) => d.name === skin)?.color ?? null };
  }

  private setSkinImage(args: Args) {
    const skin = this.skinNamed(str(args, "skin"));
    const layer = this.node(str(args, "layer"));
    const count = displaysOf(layer).length;
    if (!count) throw new AgentError(`"${layer.name}" shows no image, so a skin has nothing to put in its place.`);
    const index = args.display === undefined ? 0 : Number(args.display);
    if (!Number.isInteger(index) || index < 0 || index >= count) throw new AgentError(`"${layer.name}" has displays 0 to ${count - 1}.`);
    let itemId: ItemId | null = null;
    if (args.image !== null && args.image !== undefined) {
      const item = this.libraryImages().find((i) => i.name === args.image);
      if (!item) throw new AgentError(`There is no image "${String(args.image)}" in the library.`);
      itemId = item.id;
    }
    this.store.history.transaction("AI: Skin Image", () => {
      if (args.image !== undefined) {
        const refused = doSetSkinImage(this.store, skin, layer.id, index, itemId, "AI: Skin Image");
        if (refused) throw new AgentError(refused);
      }
      if (typeof args.only_in_skins === "boolean" && !!displaysOf(this.sym.nodes[layer.id]!)[index]!.skinOnly !== args.only_in_skins) {
        doSetSkinOnly(this.store, layer.id, index, args.only_in_skins);
      }
    });
    const ref = this.sym.skins?.find((d) => d.name === skin)?.displays?.[layer.id]?.[String(index)];
    return { skin, layer: layer.name, display: index, image: ref ? this.store.project.items[ref.itemId]?.name ?? null : null, onlyInSkins: !!displaysOf(this.sym.nodes[layer.id]!)[index]!.skinOnly };
  }

  private setSkinMembers(args: Args) {
    const skin = this.skinNamed(str(args, "skin"));
    const bones = args.bones === undefined ? [] : list<string>(args, "bones").map((n) => this.bone(n).id);
    const names = args.constraints === undefined ? [] : list<string>(args, "constraints");
    const ik: IkId[] = [], transforms: TcId[] = [], constraints: CnId[] = [];
    const others = [...(this.sym.physics ?? []), ...(this.sym.sliders ?? []), ...(this.sym.paths ?? [])];
    for (const n of names) {
      const k = this.sym.ik.find((c) => c.name === n), t = (this.sym.transforms ?? []).find((c) => c.name === n), o = others.find((c) => c.name === n);
      if (k) ik.push(k.id); else if (t) transforms.push(t.id); else if (o) constraints.push(o.id);
      else throw new AgentError(`There is no constraint "${n}". get_rig lists them in constraintOrder.`);
    }
    const refused = doSetSkinMembers(this.store, skin, { bones, ik, transforms, constraints }, args.remove !== true, "AI: Skin Members");
    if (refused) throw new AgentError(refused);
    const def = this.sym.skins?.find((d) => d.name === skin);
    return {
      skin,
      bones: (def?.bones ?? []).map((id) => this.sym.nodes[id]?.name),
      constraints: [
        ...(def?.ik ?? []).map((id) => this.sym.ik.find((c) => c.id === id)?.name),
        ...(def?.transforms ?? []).map((id) => this.sym.transforms?.find((c) => c.id === id)?.name),
        ...(def?.constraints ?? []).map((id) => others.find((c) => c.id === id)?.name),
      ],
    };
  }

  private addTransform(args: Args) {
    const s = this.sym;
    const bones = list<string>(args, "bones").map((n) => this.bone(n).id);
    const source = this.bone(str(args, "source"));
    const plan = transformPlan(s, bones, source.id, newTcId());
    if ("refused" in plan) throw new AgentError(plan.refused);
    const k: TransformConstraint = { ...plan };
    if (typeof args.name === "string" && args.name.trim()) {
      if ((s.transforms ?? []).some((c) => c.name === args.name)) throw new AgentError(`There is already a transform constraint "${args.name}".`);
      k.name = (args.name as string).trim();
    }
    for (const f of ["localSource", "localTarget", "clamp"] as const) if (args[f] === true) k[f] = true;
    if (args.relative === true) k.additive = true;
    const mix = args.mix && typeof args.mix === "object" ? (args.mix as Record<string, unknown>) : {};
    for (const c of TC_CHANNELS) if (typeof mix[c] === "number") k.mix = { ...k.mix, [c]: Math.min(1, Math.max(0, mix[c] as number)) };
    const off = args.offsets && typeof args.offsets === "object" ? (args.offsets as Record<string, unknown>) : {};
    const offsets: Partial<Record<TcChannel, number>> = {};
    for (const c of TC_CHANNELS) if (typeof off[c] === "number" && off[c]) offsets[c] = off[c] as number;
    if (Object.keys(offsets).length) k.offsets = offsets;
    this.store.apply(new SetTransforms(`AI: Transform Constraint "${k.name}"`, this.store.currentSymbolId, [...(s.transforms ?? []), k]));
    this.store.emit("stage");
    return { name: k.name, source: source.name, bones: k.boneIds.map((id) => s.nodes[id]!.name) };
  }

  private keyTransform(animName: string, name: string, frame: number, args: Args) {
    const anim = this.animation(animName);
    const k = (this.sym.transforms ?? []).find((c) => c.name === name);
    if (!k) throw new AgentError(`There is no transform constraint "${name}". get_rig lists them.`);
    if (args.ease !== undefined && args.ease !== "linear" && args.ease !== "stepped" && args.ease !== "smooth") throw new AgentError(`ease is "linear", "stepped" or "smooth".`);
    const before = anim.transforms?.[k.id] ?? [];
    let keys: TcKey[];
    if (args.delete === true) {
      if (!before.some((key) => key.frame === frame)) throw new AgentError(`"${name}" has no key at frame ${frame}.`);
      keys = deleteTcKeys(before, [frame]);
    } else {
      const mix = { ...tcMixAt(k, anim, frame) };
      const given = args.mix && typeof args.mix === "object" ? (args.mix as Record<string, unknown>) : {};
      for (const c of TC_CHANNELS) if (typeof given[c] === "number") mix[c] = Math.min(1, Math.max(0, given[c] as number));
      keys = withTcKey(before, frame, mix);
      if (args.ease) keys = withTcTween(keys, [frame], args.ease as IkTween);
    }
    this.store.apply(new SetTcKeys(`AI: Transform "${k.name}" at ${frame + 1}`, this.store.currentSymbolId, anim.id, k.id, keys));
    this.store.emit("timeline");
    this.store.emit("stage");
    return { animation: anim.name, constraint: k.name, keys: keys.map((key) => ({ frame: key.frame, mix: Object.fromEntries(usedMixes(k).map((c) => [c, round(key.mix[c], 3)])), ease: tcTweenOf(key) })) };
  }

  private defineEvent(name: string, args: Args) {
    const s = this.sym;
    const defs = s.events ?? [];
    const old = defs.find((d) => d.name === name);
    if (args.delete === true) {
      if (!old) throw new AgentError(`There is no event "${name}".`);
      const out = withoutEvent(defs, s.animations, name);
      const removed = s.animations.reduce((n, a) => n + (a.events?.length ?? 0) - (out.keys.get(a.id)?.length ?? a.events?.length ?? 0), 0);
      this.store.apply(new SetEvents(`AI: Delete Event "${name}"`, this.store.currentSymbolId, out.defs, out.keys));
      this.store.emit("timeline");
      return { deleted: name, keysRemoved: removed };
    }
    for (const f of ["int", "float", "volume", "balance"] as const) {
      if (args[f] !== undefined && (typeof args[f] !== "number" || !Number.isFinite(args[f]))) throw new AgentError(`${f} is a number.`);
    }
    if (args.string !== undefined && typeof args.string !== "string") throw new AgentError("string is text.");
    if (args.audio !== undefined && typeof args.audio !== "string") throw new AgentError("audio is a sound file's path, or \"\" for none.");
    let next = defs;
    let keys = new Map<AnimId, EventKey[]>();
    let current = name;
    if (typeof args.rename === "string") {
      if (!old) throw new AgentError(`There is no event "${name}" to rename.`);
      const out = renamedEvent(defs, s.animations, name, args.rename);
      if (!out) throw new AgentError(`"${args.rename}" is empty or already an event.`);
      next = out.defs;
      keys = out.keys;
      current = args.rename.trim();
    } else if (!old) {
      if (!name.trim()) throw new AgentError("An event needs a name.");
      next = [...defs, { name: name.trim() }];
      current = name.trim();
    }
    const patch: Partial<Omit<EventDef, "name">> = {};
    if (typeof args.int === "number") patch.int = Math.trunc(args.int);
    if (typeof args.float === "number") patch.float = args.float;
    if (typeof args.string === "string") patch.string = args.string;
    if (typeof args.audio === "string") patch.audio = args.audio;
    if (typeof args.volume === "number") patch.volume = Math.max(0, Math.min(1, args.volume));
    if (typeof args.balance === "number") patch.balance = Math.max(-1, Math.min(1, args.balance));
    next = next.map((d) => (d.name === current ? withEventDefValues(d, patch) : d));
    this.store.apply(new SetEvents(`AI: Event "${current}"`, this.store.currentSymbolId, next, keys));
    this.store.emit("timeline");
    return { event: next.find((d) => d.name === current), events: next.map((d) => d.name) };
  }

  private keyEvent(animName: string, frame: number, eventName: string, args: Args) {
    const anim = this.animation(animName);
    const def = (this.sym.events ?? []).find((d) => d.name === eventName);
    if (!def) throw new AgentError(`There is no event "${eventName}". define_event makes one; get_rig lists them.`);
    let keys = anim.events ?? [];
    if (args.delete === true) {
      const at = keys.filter((k) => k.frame === frame && k.name === eventName);
      if (!at.length) throw new AgentError(`"${eventName}" is not fired at frame ${frame}.`);
      keys = keys.filter((k) => !(k.frame === frame && k.name === eventName));
    } else {
      for (const f of ["int", "float", "volume", "balance"] as const) {
        if (args[f] !== undefined && (typeof args[f] !== "number" || !Number.isFinite(args[f]))) throw new AgentError(`${f} is a number.`);
      }
      keys = withEventKey(keys, frame, eventName);
      const nth = keys.filter((k) => k.frame === frame).length - 1;
      keys = withEventKeyValues(keys, frame, nth, {
        ...(typeof args.int === "number" ? { int: Math.trunc(args.int) } : {}),
        ...(typeof args.float === "number" ? { float: args.float } : {}),
        ...(typeof args.string === "string" ? { string: args.string } : {}),
        ...(typeof args.volume === "number" ? { volume: args.volume } : {}),
        ...(typeof args.balance === "number" ? { balance: args.balance } : {}),
      });
    }
    this.store.apply(new SetEventKeys(`AI: Event "${eventName}" at ${frame + 1}`, this.store.currentSymbolId, anim.id, keys));
    this.store.emit("timeline");
    return { animation: anim.name, events: keys.map((k) => ({ ...k })) };
  }

  private keyProperties(animName: string, frame: number, layers: string[], which: unknown) {
    const anim = this.animation(animName);
    if (!layers.length) throw new AgentError("layers names at least one bone or slot.");
    const groups = Object.keys(KEY_GROUPS);
    let props: readonly TimelineProp[] | "changed";
    if (which === undefined || which === "changed") props = "changed";
    else if (which === "all") props = TIMELINE_PROPS;
    else if (Array.isArray(which) && which.length && which.every((g) => groups.includes(g as string))) props = which.flatMap((g) => KEY_GROUPS[g as KeyGroup]);
    else throw new AgentError(`properties is "changed", "all" or a list of ${groups.join(", ")}.`);
    if (frame < 0 || frame >= anim.duration) throw new AgentError(`frame is 0 to ${anim.duration - 1}.`);
    const tracks = new Map<NodeId, Track>();
    const keyed: Record<string, TimelineProp[]> = {};
    for (const node of layers.map((n) => this.node(n))) {
      const list = props === "changed" ? changedProps(anim.tracks[node.id], node, frame) : props;
      if (!list.length) continue;
      const base = anim.tracks[node.id] ?? { nodeId: node.id, keys: [createKeyframe(0, node)], endFrame: Math.max(0, anim.duration - 1) };
      const next = keyProps(base, node, list, frame);
      if (next === anim.tracks[node.id]) continue;
      tracks.set(node.id, next);
      keyed[node.name] = [...list];
    }
    if (tracks.size) {
      this.store.apply(new EditTracks(`AI: Key at ${frame + 1}`, this.store.currentSymbolId, anim.id, tracks));
      this.store.emit("timeline");
      this.store.emit("stage");
    }
    return { animation: anim.name, frame, keyed };
  }

  private offsetKeys(animName: string, layers: string[], frames: number, stagger: boolean) {
    const anim = this.animation(animName);
    if (!layers.length) throw new AgentError("layers names at least one bone or slot.");
    const nodes = layers.map((n) => this.node(n));
    const seam = seamFrame(anim);
    const tracks = new Map<NodeId, Track>();
    for (const [id, delta] of offsetPlan(nodes.map((n) => n.id), frames, stagger)) {
      const track = anim.tracks[id];
      if (!track) continue;
      const next = offsetTrack(track, this.sym.nodes[id]!, delta, seam);
      if (next !== track) tracks.set(id, next);
    }
    if (tracks.size) {
      this.store.apply(new EditTracks(`AI: Offset Keys in "${anim.name}"`, this.store.currentSymbolId, anim.id, tracks));
      this.store.emit("timeline");
      this.store.emit("stage");
    }
    return {
      animation: anim.name, wrapped: seam !== null,
      moved: nodes.filter((n) => tracks.has(n.id)).map((n) => ({ layer: n.name, frames: offsetPlan(nodes.map((m) => m.id), frames, stagger).get(n.id) })),
      ...(nodes.some((n) => !anim.tracks[n.id]) ? { unkeyed: nodes.filter((n) => !anim.tracks[n.id]).map((n) => n.name) } : {}),
    };
  }

  private setCycle(animName: string, on: unknown) {
    if (typeof on !== "boolean") throw new AgentError(`"on" is true or false.`);
    const anim = this.animation(animName);
    if (isCycle(anim) !== on) {
      const plan = on ? cyclePlan(anim, this.sym.nodes) : undefined;
      this.store.apply(new SetCycle(this.store.currentSymbolId, anim.id, on, plan, `AI: ${on ? "Cycle" : "Play Once"} "${anim.name}"`));
      this.store.emit("timeline");
      this.store.emit("stage");
    }
    const now = this.animation(animName);
    const seam = this.seamOf(now);
    return { animation: now.name, cycle: isCycle(now), frames: this.frames(now), ...(seam ? { seam } : {}) };
  }

  private pathOf(anim: Animation, node: Node, point: "tip" | "origin") {
    const { frames, closed } = pathFrames(anim);
    const p = this.store.project;
    return bonePaths({
      sample: (f) => posedSymbol(p, this.sym, anim, f, "animate"),
      ids: [node.id], frames, closed, which: point, isKey: keyedIn(anim),
    })[0]!;
  }

  private getBonePath(animName: string, boneName: string, pointArg: unknown) {
    if (pointArg !== undefined && pointArg !== "tip" && pointArg !== "origin") throw new AgentError(`point is "tip" or "origin".`);
    const anim = this.animation(animName);
    const node = this.bone(boneName);
    const path = this.pathOf(anim, node, (pointArg as "tip" | "origin" | undefined) ?? "tip");
    return {
      animation: anim.name, bone: node.name, point: pointArg ?? "tip", closed: path.closed, fps: this.store.project.frameRate,
      // y up, as get_pose reports.
      points: path.points.map((q) => ({ frame: q.frame, x: round(q.x, 2), y: round(-q.y, 2), ...(q.key ? { key: true } : {}) })),
    };
  }

  private setBonePath(animName: string, boneName: string, keys: PathKeyIn[]) {
    const anim = this.animation(animName);
    const node = this.bone(boneName);
    const rule = pathDragMode(this.sym, anim, node.id, "origin", false);
    if ("refused" in rule) throw new AgentError(rule.refused);
    if (rule.mode === "throughTarget") {
      const target = this.sym.nodes[this.sym.ik.find((k) => k.id === rule.ik.ik)!.targetId]!.name;
      throw new AgentError(`"${node.name}" is moved by IK: key its target "${target}" instead.`);
    }
    const pair = (v: unknown, where: string): { x: number; y: number } => {
      const [x, y] = point(v, where);
      return { x, y: -y };
    };
    for (const k of keys) {
      if (!Number.isInteger(k.frame) || k.frame < 0) throw new AgentError("Each key's frame is a whole number, 0 or more.");
      if (typeof k.x !== "number" || typeof k.y !== "number" || !Number.isFinite(k.x) || !Number.isFinite(k.y)) throw new AgentError(`Key at ${k.frame}: x and y are numbers.`);
    }
    const sorted = [...keys].sort((a, b) => a.frame - b.frame);
    if (new Set(sorted.map((k) => k.frame)).size !== sorted.length) throw new AgentError("Two keys at the same frame.");
    const label = `AI: Path of "${node.name}"`;
    const splits: number[] = [];
    let clamped = false;
    this.store.transaction(label, () => {
      this.setKeys(anim.name, sorted.map((k) => ({ bone: node.name, frame: k.frame, x: k.x, y: k.y })));
      let track = this.animation(animName).tracks[node.id]!;
      for (let i = 0; i + 1 < sorted.length; i++) {
        const a = sorted[i]!, b = sorted[i + 1]!;
        if (!a.out && !b.in) continue;
        const ka = track.keys[keyIndexAt(track, a.frame)]!;
        const kb = track.keys[keyIndexAt(track, a.frame) + 1]!;
        if (kb.frame !== b.frame) throw new AgentError(`"${node.name}" has a key at frame ${kb.frame}, between ${a.frame} and ${b.frame}: a handle bends one interval between two keys next to each other.`);
        const base: Spline = easesToSpline(ka, kb) ?? straightSpline(ka, kb);
        const s: Spline = {
          ...base,
          p1: a.out ? pair(a.out, `Key at ${a.frame}: out`) : base.p1,
          p2: b.in ? pair(b.in, `Key at ${b.frame}: in`) : base.p2,
        };
        const edit = withSpline(track, node, a.frame, s);
        if ("refused" in edit) throw new AgentError(`Between ${a.frame} and ${b.frame}: ${edit.refused}`);
        if (edit.split !== null) splits.push(edit.split);
        clamped ||= edit.clamped;
        track = edit.track;
      }
      this.commit(this.animation(animName), label, new Map([[node.id, track]]));
    });
    return {
      animation: anim.name, bone: node.name, keys: sorted.length,
      ...(splits.length ? { addedKeys: splits, note: "An axis that did not move between two keys had to bend: a key was added in the middle of that interval." } : {}),
      ...(clamped ? { clamped: "A handle was pulled in: that axis moves too little between its keys for the handle to reach so far." } : {}),
    };
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
  private async renderFrame(animName: string | null, frame: number, withReference: boolean, withBones: boolean, pathsArg?: unknown) {
    const anim = animName === null ? null : this.animation(animName);
    const { boxes, bones } = this.frameView(anim, frame);
    if (pathsArg !== undefined && (!Array.isArray(pathsArg) || !pathsArg.every((n) => typeof n === "string"))) throw new AgentError("paths is a list of bone names.");
    if (pathsArg && !anim) throw new AgentError("paths needs an animation: a path is where a bone goes over it.");
    const paths = anim ? ((pathsArg as string[] | undefined) ?? []).map((name) => ({ name, path: this.pathOf(anim, this.bone(name), "tip") })) : [];
    // Framed to hold the paths whole.
    for (const { path } of paths) for (const q of path.points) boxes.push({ x: q.x, y: q.y, w: 1e-3, h: 1e-3 });
    // Framed on what is drawn: helper bones far from the artwork (an aim
    // target, a crosshair) would shrink the body to a corner. A rig that
    // draws nothing is framed on its bones.
    if (boxes.length === 0) for (const b of bones) boxes.push({ x: Math.min(b.from[0], b.to[0]), y: Math.min(b.from[1], b.to[1]), w: Math.abs(b.to[0] - b.from[0]) || 1e-3, h: Math.abs(b.to[1] - b.from[1]) || 1e-3 });
    const ref = withReference && anim?.reference && referenceIndexAt(anim.reference, frame) !== null ? anim.reference : undefined;
    if (ref) boxes.push(referenceRect(ref));
    const view = imageFrame(boxes, RENDER_SIDE);
    const marks = bones.map((b) => mark(b, view));
    const inside = (p: [number, number]) => p[0] >= 0 && p[1] >= 0 && p[0] <= view.width && p[1] <= view.height;
    const join = anim ? seamFrame(anim) : null;
    const shownFrame = frame === join ? 0 : frame;
    const pathMarks: PathMark[] = paths.map(({ name, path }) => ({
      name, closed: path.closed,
      points: path.points.map((q) => view.toPixel(q.x, q.y)),
      keys: path.points.map((q) => q.key),
      current: path.points.findIndex((q) => q.frame === shownFrame),
    }));
    const image = await this.needVision().render({ symbol: this.sym, animation: anim, frame, view, reference: !!ref, bones: withBones ? marks : [], ...(pathMarks.length ? { paths: pathMarks } : {}) });
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
      ...(pathMarks.length ? { paths: Object.fromEntries(pathMarks.map((m) => [m.name, { frames: m.points.length, closed: m.closed, keyedFrames: paths.find((p) => p.name === m.name)!.path.points.filter((q) => q.key).map((q) => q.frame) }])) } : {}),
      note: "Bones named far or right are drawn blue, the others magenta. Names that would overlap are left off the picture; every bone is listed here. Bones marked outside are beyond the picture's edges." + (pathMarks.length ? " Each path is an orange line through the tip at every frame, a ring on each keyed frame, a filled dot on this frame." : ""),
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
  async renderPoses(
    animName: string, frames: number[], style: PoseStyle = "both", each?: (image: AgentImage, index: number) => void,
    /** Each pose over the reference picture at its frame, when there is one. */
    withReference = false,
  ): Promise<AgentImage[]> {
    const anim = this.animation(animName);
    const views = frames.map((f) => this.frameView(anim, f));
    const boxes = views.flatMap((v) => v.boxes);
    if (boxes.length === 0) for (const v of views) for (const b of v.bones) {
      boxes.push({ x: Math.min(b.from[0], b.to[0]), y: Math.min(b.from[1], b.to[1]), w: Math.abs(b.to[0] - b.from[0]) || 1e-3, h: Math.abs(b.to[1] - b.from[1]) || 1e-3 });
    }
    const ref = withReference ? anim.reference : undefined;
    const over = frames.map((f) => !!ref && referenceIndexAt(ref, f) !== null);
    // The reference in the shared framing too, or a pose drawn over it would crop it.
    if (ref && over.some(Boolean)) boxes.push(referenceRect(ref));
    const view = imageFrame(boxes, RENDER_SIDE);
    const images: AgentImage[] = [];
    for (let i = 0; i < frames.length; i++) {
      const marks = views[i]!.bones.map((b) => mark(b, view));
      const image = await this.needVision().render({
        symbol: this.sym, animation: anim, frame: frames[i]!, view, reference: over[i]!,
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
    const names = exportBoneBurst(this.store.project, this.sym.id, { setupOnly: true }).names;
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
    const seam = this.seamOf(anim);
    return { animation: anim.name, framesChecked: new Set(frames).size, worstPixels: round(worst, 6), ...(where ? { worstAt: where } : {}), matches: worst <= 0.01, ...(seam ? { seam } : {}) };
  }
}

/* ── helpers ── */

function mark(b: { name: string; from: [number, number]; to: [number, number] }, view: ImageFrame): BoneMark {
  const side = boneSide(b.name);
  return { name: b.name, from: view.toPixel(...b.from), to: view.toPixel(...b.to), ...(side ? { side } : {}) };
}

function spine(l: BoneBurstLocal) {
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

function point(v: unknown, where: string): BoneBurstPoint {
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) throw new AgentError(`${where} is two numbers, [x, y].`);
  return [v[0] as number, v[1] as number];
}

function str(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new AgentError(`"${key}" is required, as text.`);
  return v;
}

/** An IK key as the AI reads it: the softness only where it is not 0. */
function ikKeyOut(k: IkConstraint, key: IkKey) {
  const softness = key.softness ?? k.softness ?? 0;
  return { mix: round(key.mix, 3), bendPositive: key.bendPositive, ...(softness ? { softness: round(softness, 3) } : {}), ease: ikTweenOf(key) };
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
