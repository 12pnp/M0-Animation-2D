import type { Store } from "@/app/Store";
import type { AnimId, AssetId, NodeId } from "@/core/doc/ids";
import { type Animation, type ImageItem, isImage, type Node, type SymbolItem, type Track } from "@/core/doc/types";
import type { ImageFrame } from "@/core/doc/reference";
import { EditTracks } from "@/core/history/timelineCommands";
import type { AssetStore } from "@/app/AssetStore";
import { posedSymbol } from "@/core/boneburst/boneburstPose";
import { exportBoneBurst } from "@/core/boneburst/exportBoneBurst";
import TOOLS from "./tools.json";
import { AgentError, int, list, round, str, type Args, type AttachIn, type BoneIn, type PathKeyIn, type SpineKeyIn } from "./agentArgs";
import { getRig, getAnimation, getPose } from "./agentRead";
import { deleteBoneKeys, newAnimation, setKeys, show, keyDrawOrder, keyIk, keyConstraint, keySequence, keyTransform, keyEvent, defineEvent, keyProperties, offsetKeys, setCycle, seamOf } from "./agentKeys";
import { addBones, attach, addIk, drawOrder, autoRig } from "./agentRig";
import { listMotions, applyMotion } from "./agentMotion";
import { makeMeshes, bindMesh, addAttachment, addPhysics, linkMesh, setPoint, setTint, mapTransform, setInherit, setConstraintOrder, addSlider, makePath, makeSequence, addTransform } from "./agentAttach";
import { addSkin, setSkinColor, setSkinImage, setSkinMembers } from "./agentSkins";
import { getBonePath, setBonePath } from "./agentPaths";
import { getReference, renderFrame } from "./agentLook";

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

/** The runtime's bone matrices at a frame ([a, b, c, d, x, y], y down), by
 *  bone name: the page's Preview. */
export interface PreviewProbe {
  matricesAt(animation: string, frame: number): Promise<Record<string, number[]>>;
}

/** A picture for the model, base64. */
export interface AgentImage { mimeType: string; data: string }

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


/** The page's File › Export to Unity, for `export_to_unity` (docs/BONEBURST-PIPELINE-PLAN.md R4). */
export interface UnityExporter {
  /** Writes the export into the document's Unity folder; throws when none is granted yet. */
  export(): Promise<{ folder: string; files: string[] }>;
}

export class AgentApi {
  constructor(
    readonly store: Store, private readonly preview?: PreviewProbe, private readonly vision?: AgentVision,
    /** The images' pixels, for a mesh's outline; without, a mesh is the image's rectangle. */
    readonly assets?: AssetStore,
    private readonly unity?: UnityExporter,
  ) {}

  get tools(): AgentTool[] { return AGENT_TOOLS; }

  async call(name: string, args: Args = {}): Promise<unknown> {
    switch (name) {
      case "get_rig": return getRig(this);
      case "get_animation": return getAnimation(this, str(args, "animation"));
      case "get_pose": return getPose(this, args);
      case "new_animation": return newAnimation(this, str(args, "name"), int(args, "frames", 1));
      case "set_keys": return setKeys(this, str(args, "animation"), list<SpineKeyIn>(args, "keys"));
      case "delete_keys": return deleteBoneKeys(this, str(args, "animation"), list<{ bone: string; frame: number }>(args, "keys"));
      case "show": return show(this, str(args, "animation"), typeof args.frame === "number" ? args.frame : 0, args.skins);
      case "undo": return this.step("undo", typeof args.steps === "number" ? args.steps : 1);
      case "redo": return this.step("redo", typeof args.steps === "number" ? args.steps : 1);
      case "check_preview": return this.checkPreview(str(args, "animation"), args.frames);
      case "export_to_unity": return this.exportToUnity();
      case "get_reference": return getReference(this, str(args, "animation"), args.frames);
      case "render_frame": return renderFrame(this, typeof args.animation === "string" ? args.animation : null, args.frame === undefined ? 0 : int(args, "frame", 0), args.reference !== false, args.bones !== false, args.paths);
      case "add_bones": return addBones(this, list<BoneIn>(args, "bones"));
      case "attach": return attach(this, list<AttachIn>(args, "items"));
      case "add_ik": return addIk(this, str(args, "bone"), args);
      case "auto_rig": return autoRig(this, args);
      case "list_motions": return listMotions(this);
      case "apply_motion": return applyMotion(this, str(args, "motion"), args);
      case "draw_order": return drawOrder(this, typeof args.parent === "string" ? args.parent : null, list<string>(args, "front"));
      case "set_cycle": return setCycle(this, str(args, "animation"), args.on);
      case "key_properties": return keyProperties(this, str(args, "animation"), int(args, "frame", 0), list<string>(args, "layers"), args.properties);
      case "offset_keys": return offsetKeys(this, str(args, "animation"), list<string>(args, "layers"), int(args, "frames", 0), args.stagger === true);
      case "key_draw_order": return keyDrawOrder(this, str(args, "animation"), int(args, "frame", 0), args);
      case "key_ik": return keyIk(this, str(args, "animation"), str(args, "ik"), int(args, "frame", 0), args);
      case "define_event": return defineEvent(this, str(args, "name"), args);
      case "add_transform_constraint": return addTransform(this, args);
      case "make_mesh": return makeMeshes(this, list<string>(args, "images"), args.spacing);
      case "bind_mesh": return bindMesh(this, str(args, "image"), list<string>(args, "bones"));
      case "add_skin": return addSkin(this, str(args, "name"));
      case "add_attachment": return addAttachment(this, args);
      case "make_sequence": return makeSequence(this, str(args, "layer"));
      case "add_physics": return addPhysics(this, str(args, "bone"), args);
      case "add_slider": return addSlider(this, str(args, "animation"), args);
      case "make_path": return makePath(this, list<string>(args, "bones"));
      case "link_mesh": return linkMesh(this, str(args, "layer"), str(args, "image"), args);
      case "key_constraint": return keyConstraint(this, str(args, "animation"), str(args, "constraint"), str(args, "channel"), int(args, "frame", 0), args);
      case "set_inherit": return setInherit(this, str(args, "bone"), args);
      case "set_point": return setPoint(this, str(args, "point"), args);
      case "set_tint": return setTint(this, str(args, "layer"), args);
      case "map_transform": return mapTransform(this, str(args, "constraint"), args);
      case "set_skin_color": return setSkinColor(this, str(args, "skin"), args.color);
      case "set_constraint_order": return setConstraintOrder(this, list<string>(args, "order"));
      case "key_sequence": return keySequence(this, str(args, "animation"), str(args, "layer"), int(args, "frame", 0), args);
      case "set_skin_image": return setSkinImage(this, args);
      case "set_skin_members": return setSkinMembers(this, args);
      case "key_transform": return keyTransform(this, str(args, "animation"), str(args, "constraint"), int(args, "frame", 0), args);
      case "key_event": return keyEvent(this, str(args, "animation"), int(args, "frame", 0), str(args, "event"), args);
      case "get_bone_path": return getBonePath(this, str(args, "animation"), str(args, "bone"), args.point);
      case "set_bone_path": return setBonePath(this, str(args, "animation"), str(args, "bone"), list<PathKeyIn>(args, "keys"));
      default: throw new AgentError(`There is no tool "${name}".`);
    }
  }

  /* ── reading ── */

  get sym(): SymbolItem { return this.store.currentSymbol; }

  /** Nodes that are bones in Spine: everything but slots riding a bone and
   *  empty placeholders. */
  bones(): Node[] {
    const s = this.sym;
    const order = s.layers.map((l) => s.nodes[l.nodeId]).filter((n): n is Node => !!n);
    return order.filter((n) => !n.slotBone && n.kind !== "empty");
  }

  bone(name: string): Node {
    const found = this.bones().filter((n) => n.name === name);
    if (found.length === 0) throw new AgentError(`There is no bone "${name}". get_rig lists them.`);
    return found[0]!;
  }

  animation(name: string): Animation {
    const anim = this.sym.animations.find((a) => a.name === name);
    if (!anim) throw new AgentError(`There is no animation "${name}". Animations: ${this.sym.animations.map((a) => `"${a.name}"`).join(", ")}.`);
    return anim;
  }

  /** Its length as Spine counts it: the frame where a loop wraps. */
  frames(anim: Animation): number {
    return anim.endsAtLastFrame ? anim.duration - 1 : anim.duration;
  }

  commit(anim: Animation, label: string, tracks: Map<NodeId, Track | undefined>): void {
    this.store.transaction(label, () => {
      this.store.apply(new EditTracks(label, this.store.currentSymbolId, anim.id as AnimId, tracks, "agent.keys"));
    });
    this.store.emit("timeline");
    this.store.emit("stage");
  }

  /* ── rigging ── */

  libraryImages(): ImageItem[] {
    const p = this.store.project;
    return p.itemOrder.map((id) => p.items[id]).filter((i): i is ImageItem => !!i && isImage(i));
  }

  /** Every node but empty layers, by name: bones, and slots that ride one. */
  node(name: string): Node {
    const found = Object.values(this.sym.nodes).find((n) => n.name === name && n.kind !== "empty");
    if (!found) throw new AgentError(`There is no bone or slot "${name}". get_rig lists them.`);
    return found;
  }

  nameTaken(name: string): boolean {
    return Object.values(this.sym.nodes).some((n) => n.name === name);
  }

  /** A node's world matrix in the setup pose, as the runtime poses it. */
  setupWorld(id: NodeId) {
    return posedSymbol(this.store.project, this.sym, null, 0, "setup").byNode.get(id)?.world;
  }

  /* ── Unity ── */

  private async exportToUnity() {
    if (!this.unity) throw new AgentError("Exporting to Unity needs the editor page; this host cannot write files.");
    try {
      const { folder, files } = await this.unity.export();
      return {
        folder, files,
        note: "Unity rebakes the folder on its next refresh (when its window is focused, or Assets › Refresh) if it was baked before; " +
          "the first time, the user right-clicks the folder › BoneBurst › Bake Folder… to choose where the baked asset goes.",
      };
    } catch (err) {
      throw new AgentError(err instanceof Error ? err.message : String(err));
    }
  }

  needVision(): AgentVision {
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
    const seam = seamOf(this, anim);
    return { animation: anim.name, framesChecked: new Set(frames).size, worstPixels: round(worst, 6), ...(where ? { worstAt: where } : {}), matches: worst <= 0.01, ...(seam ? { seam } : {}) };
  }
}

