import type { AtlasImages, ImageRegion } from "./regions";
import { type Json, num, obj, list, parseColor } from "./rigJson";
import { type Skipped, type SkippedSubject, type BoneBurstInherit, type TransformProp, type TransformMix, type BoneData, type SlotData, type ConstraintData, type SkinData, type AnimationData, type BlendMode, type IkScaleY, TRANSFORM_PROPS, type PathConstraintData, PHYSICS_PROPS, type PhysicsProp, type MeshData, type AttachmentData, type SliderData, type RigData, type EventFire } from "./rigTypes";
import { readMesh, readRegion, readPath, readClipping, readBox, readPoint, linkMesh } from "./rigAttachments";
import { readAnimation } from "./rigAnimation";

/**
 * A transform constraint's mixes, as spine-core 4.3.13 reads them (measured):
 * only for the properties its map drives, absent ones 1 — but y's mix is read
 * only when x is driven (absent: x's), and scale y's only when scale x is
 * (absent: scale x's), so a map that drives y and not x leaves y's mix 0.
 */
function constraintMixes(k: Json, driven: ReadonlySet<TransformProp>): TransformMix {
  const m: TransformMix = { rotate: 0, x: 0, y: 0, scaleX: 0, scaleY: 0, shearY: 0 };
  if (driven.has("rotate")) m.rotate = num(k.mixRotate, 1);
  if (driven.has("x")) { m.x = num(k.mixX, 1); m.y = num(k.mixY, m.x); }
  if (driven.has("scaleX")) { m.scaleX = num(k.mixScaleX, 1); m.scaleY = num(k.mixScaleY, m.scaleX); }
  if (driven.has("shearY")) m.shearY = num(k.mixShearY, 1);
  return m;
}

export function readRig(json: unknown, atlas: AtlasImages): RigData {
  const file = obj(json);
  // Each skipped part once, by its message (E8-PLAN step 1).
  const skipped = new Map<string, Skipped>();
  const skip = (message: string, subject?: SkippedSubject) => { if (!skipped.has(message)) skipped.set(message, subject ? { message, subject } : { message }); };
  /** The names in `names` the skeleton lacks, as a phrase. */
  const lacking = (names: readonly unknown[]) => names.map(String).filter((n) => !boneIndex.has(n)).map((n) => `"${n}"`).join(", ");

  const bones: BoneData[] = [];
  const boneIndex = new Map<string, number>();
  for (const b of list(file.bones)) {
    const name = String(b.name);
    const inherit = (typeof b.inherit === "string" ? b.inherit : "normal") as BoneBurstInherit;
    const bone: BoneData = {
      index: bones.length, name, parent: typeof b.parent === "string" ? boneIndex.get(b.parent) ?? -1 : -1,
      length: num(b.length, 0),
      x: num(b.x, 0), y: num(b.y, 0), rotation: num(b.rotation, 0),
      scaleX: num(b.scaleX, 1), scaleY: num(b.scaleY, 1), shearX: num(b.shearX, 0), shearY: num(b.shearY, 0),
      inherit, skinRequired: b.skin === true,
    };
    boneIndex.set(name, bone.index);
    bones.push(bone);
  }

  const slots: SlotData[] = [];
  const slotIndex = new Map<string, number>();
  for (const s of list(file.slots)) {
    const bone = boneIndex.get(String(s.bone));
    if (bone === undefined) throw new Error(`Slot "${String(s.name)}" names a bone "${String(s.bone)}" the skeleton lacks.`);
    const slot: SlotData = {
      index: slots.length, name: String(s.name), bone, color: parseColor(s.color),
      dark: typeof s.dark === "string" ? parseColor(s.dark).slice(0, 3) as [number, number, number] : null,
      attachment: typeof s.attachment === "string" ? s.attachment : null,
      blend: (["additive", "multiply", "screen"].includes(s.blend as string) ? s.blend : "normal") as BlendMode,
    };
    slotIndex.set(slot.name, slot.index);
    slots.push(slot);
  }

  const constraints: ConstraintData[] = [];
  const constraintIndex = new Map<string, number>();
  // A slider names its animation, which is read later.
  const sliderAnimations = new Map<number, string>();
  // 4.3 lists every constraint in one array, in order; older files kept one
  // list per kind.
  const declared: Json[] = [
    ...list(file.constraints),
    ...["ik", "transform", "path", "physics", "slider"].flatMap((type) => list(file[type]).map((k): Json => ({ type, ...k }))),
  ];
  for (const k of declared) {
    const type = typeof k.type === "string" ? k.type : "ik";
    const name = String(k.name);
    if (type === "ik") {
      const bonesOf = (Array.isArray(k.bones) ? k.bones : []).map((n) => boneIndex.get(String(n)));
      const target = boneIndex.get(String(k.target));
      if (target === undefined || !bonesOf.length || bonesOf.some((b) => b === undefined)) {
        skip(!bonesOf.length ? `IK "${name}" names no bones; it is not solved` : `IK "${name}" names bones the skeleton lacks (${lacking([...(Array.isArray(k.bones) ? k.bones : []), k.target])}); it is not solved`, { kind: "constraint", type, name });
        continue;
      }
      constraintIndex.set(name, constraints.length);
      constraints.push({
        kind: "ik", name, bones: bonesOf as number[], target,
        mix: num(k.mix, 1), softness: num(k.softness, 0), bendPositive: k.bendPositive !== false,
        compress: k.compress === true, stretch: k.stretch === true,
        scaleY: (k.scaleY === "uniform" || k.scaleY === "volume" ? k.scaleY : k.uniform === true ? "uniform" : "none") as IkScaleY,
        skinRequired: k.skin === true,
      });
    } else if (type === "transform") {
      const bonesOf = (Array.isArray(k.bones) ? k.bones : []).map((n) => boneIndex.get(String(n)));
      const source = boneIndex.get(String(k.source ?? k.target));
      if (source === undefined || bonesOf.some((b) => b === undefined)) {
        skip(`transform constraint "${name}" names bones the skeleton lacks (${lacking([...(Array.isArray(k.bones) ? k.bones : []), k.source ?? k.target])}); it is not applied`, { kind: "constraint", type, name });
        continue;
      }
      constraintIndex.set(name, constraints.length);
      const props = obj(k.properties);
      const driven = new Set<TransformProp>(Object.values(props).flatMap((f) => Object.keys(obj(obj(f).to)) as TransformProp[]));
      constraints.push({
        kind: "transform", name, bones: bonesOf as number[], source,
        localSource: k.localSource === true, localTarget: k.localTarget === true,
        additive: k.additive === true, clamp: k.clamp === true,
        offsets: {
          rotate: num(k.rotation, 0), x: num(k.x, 0), y: num(k.y, 0),
          scaleX: num(k.scaleX, 0), scaleY: num(k.scaleY, 0), shearY: num(k.shearY, 0),
        },
        properties: TRANSFORM_PROPS.filter((from) => from in props).map((from) => {
          const f = obj(props[from]);
          const to = obj(f.to);
          return {
            from, offset: num(f.offset, 0),
            to: TRANSFORM_PROPS.filter((p) => p in to).map((prop) => {
              const t = obj(to[prop]);
              return { prop, offset: num(t.offset, 0), max: num(t.max, 1), scale: num(t.scale, 1) };
            }),
          };
        }),
        mix: constraintMixes(k, driven),
        skinRequired: k.skin === true,
      });
    } else if (type === "path") {
      const bonesOf = (Array.isArray(k.bones) ? k.bones : []).map((n) => boneIndex.get(String(n)));
      const slot = slotIndex.get(String(k.slot));
      if (slot === undefined || bonesOf.some((b) => b === undefined)) {
        const what = slot === undefined ? `the slot "${String(k.slot)}", which the skeleton lacks` : `bones the skeleton lacks (${lacking(Array.isArray(k.bones) ? k.bones : [])})`;
        skip(`path constraint "${name}" names ${what}; it is not applied`, { kind: "constraint", type, name });
        continue;
      }
      constraintIndex.set(name, constraints.length);
      const mixX = num(k.mixX, 1);
      constraints.push({
        kind: "path", name, bones: bonesOf as number[], slot,
        positionMode: k.positionMode === "fixed" ? "fixed" : "percent",
        spacingMode: (["fixed", "percent", "proportional"].includes(k.spacingMode as string) ? k.spacingMode : "length") as PathConstraintData["spacingMode"],
        rotateMode: (["chain", "chainScale"].includes(k.rotateMode as string) ? k.rotateMode : "tangent") as PathConstraintData["rotateMode"],
        offsetRotation: num(k.rotation, 0), position: num(k.position, 0), spacing: num(k.spacing, 0),
        mixRotate: num(k.mixRotate, 1), mixX, mixY: num(k.mixY, mixX),
        skinRequired: k.skin === true,
      });
    } else if (type === "physics") {
      const bone = boneIndex.get(String(k.bone));
      if (bone === undefined) { skip(`physics "${name}" names a bone the skeleton lacks ("${String(k.bone)}"); it does nothing`, { kind: "constraint", type, name }); continue; }
      constraintIndex.set(name, constraints.length);
      constraints.push({
        kind: "physics", name, bone,
        x: num(k.x, 0), y: num(k.y, 0), rotate: num(k.rotate, 0), scaleX: num(k.scaleX, 0), shearX: num(k.shearX, 0),
        limit: num(k.limit, 5000), step: 1 / num(k.fps, 60),
        inertia: num(k.inertia, 0.5), strength: num(k.strength, 100), damping: num(k.damping, 0.85),
        massInverse: 1 / num(k.mass, 1), wind: num(k.wind, 0), gravity: num(k.gravity, 0), mix: num(k.mix, 1),
        global: Object.fromEntries(PHYSICS_PROPS.map((p) => [p, k[`${p}Global`] === true])) as Record<PhysicsProp, boolean>,
        skinRequired: k.skin === true,
      });
    } else if (type === "slider") {
      const bone = typeof k.bone === "string" ? boneIndex.get(k.bone) : undefined;
      if (typeof k.bone === "string" && bone === undefined) { skip(`slider "${name}" names a bone the skeleton lacks ("${k.bone}"); it does nothing`, { kind: "constraint", type, name }); continue; }
      constraintIndex.set(name, constraints.length);
      constraints.push({
        kind: "slider", name, animation: -1, bone: bone ?? -1,
        property: (TRANSFORM_PROPS as readonly string[]).includes(k.property as string) ? k.property as TransformProp : "rotate",
        local: k.local === true, from: num(k.from, 0), to: num(k.to, 0), scale: num(k.scale, 1),
        loop: k.loop === true, additive: k.additive === true, time: num(k.time, 0), mix: num(k.mix, 1),
        skinRequired: k.skin === true, bones: [],
      });
      sliderAnimations.set(constraints.length - 1, String(k.animation));
    } else {
      skip(`constraint "${name}" is a ${type} constraint, which this editor does not play`, { kind: "constraint", type, name });
    }
  }

  const regions = new Map<string, ImageRegion>();
  for (const r of atlas.regions) if (!regions.has(r.name)) regions.set(r.name, r);

  const skins: SkinData[] = [];
  // A linked mesh takes its source's geometry, which may be in a skin read later.
  const linked: Array<{ mesh: MeshData; a: Json; skin: string; slot: number; sourceSlot: number | undefined; at: { skin: string; slot: string; key: string } }> = [];
  for (const sk of list(file.skins)) {
    const skin: SkinData = {
      name: String(sk.name), attachments: new Map(),
      bones: (Array.isArray(sk.bones) ? sk.bones : []).map((n) => boneIndex.get(String(n))).filter((i): i is number => i !== undefined),
      constraints: ["ik", "transform", "path", "physics", "slider"]
        .flatMap((kind) => (Array.isArray(sk[kind]) ? sk[kind] as unknown[] : []))
        .map((n) => constraintIndex.get(String(n))).filter((i): i is number => i !== undefined),
    };
    for (const [slotName, entries] of Object.entries(obj(sk.attachments))) {
      const slot = slotIndex.get(slotName);
      if (slot === undefined) continue;
      const byKey = new Map<string, AttachmentData>();
      for (const [key, raw] of Object.entries(obj(entries))) {
        const a = obj(raw);
        const type = typeof a.type === "string" ? a.type : "region";
        // A mesh is linked when it names a `source`, whatever its type says
        // (Format-Json-Atlas.md §8.4); the source may sit in another `slot`.
        const isLinked = (type === "mesh" || type === "linkedmesh") && typeof a.source === "string";
        if (isLinked) {
          const mesh = readMesh(key, { ...a, vertices: [], uvs: [], triangles: [] }, regions);
          const sourceSlot = typeof a.slot === "string" ? slotIndex.get(a.slot) : slot;
          linked.push({ mesh, a, skin: typeof a.skin === "string" ? a.skin : "default", slot, sourceSlot, at: { skin: skin.name, slot: slotName, key } });
          byKey.set(key, mesh);
        } else if (type === "region") byKey.set(key, readRegion(key, a, regions));
        else if (type === "mesh") byKey.set(key, readMesh(key, a, regions));
        else if (type === "path") byKey.set(key, readPath(key, a));
        else if (type === "clipping") byKey.set(key, readClipping(key, a, slotIndex));
        else if (type === "boundingbox") byKey.set(key, readBox(key, a));
        else if (type === "point") byKey.set(key, readPoint(key, a));
        else if (type === "linkedmesh") skip(`"${key}" in "${slotName}" of skin "${skin.name}" is a linked mesh without a source; it is not drawn`, { kind: "attachment", skin: skin.name, slot: slotName, key });
        else skip(`"${key}" in "${slotName}" of skin "${skin.name}" is a ${type} attachment, which this editor does not draw`, { kind: "attachment", skin: skin.name, slot: slotName, key });
      }
      skin.attachments.set(slot, byKey);
    }
    skins.push(skin);
  }
  for (const { mesh, a, skin, slot, sourceSlot, at } of linked) {
    const source = sourceSlot === undefined ? undefined : skins.find((s) => s.name === skin)?.attachments.get(sourceSlot)?.get(String(a.source));
    if (source?.kind !== "mesh") { skip(`"${at.key}" in "${at.slot}" of skin "${at.skin}" links to the mesh "${String(a.source)}", which is not there; it is not drawn`, { kind: "attachment", ...at }); continue; }
    linkMesh(mesh, source, a.timelines !== false);
    // Its source's keys play in this slot too (§9 step 6).
    if (a.timelines !== false && slot !== sourceSlot && !source.timelineSlots.includes(slot)) source.timelineSlots.push(slot);
  }

  const eventData = new Map<string, EventFire>();
  for (const [name, raw] of Object.entries(obj(file.events))) {
    const e = obj(raw);
    eventData.set(name, {
      name, int: num(e.int, 0), float: num(e.float, 0), string: typeof e.string === "string" ? e.string : "",
      audio: typeof e.audio === "string" ? e.audio : null, volume: num(e.volume, 1), balance: num(e.balance, 0),
    });
  }

  const animations: AnimationData[] = [];
  for (const [name, raw] of Object.entries(obj(file.animations))) {
    animations.push(readAnimation(name, obj(raw), boneIndex, slotIndex, constraintIndex, slots.length, skins, eventData, (what) => skip(`animation "${name}": ${what} are not played`, { kind: "animation", name })));
  }

  for (const [i, animName] of sliderAnimations) {
    const k = constraints[i] as SliderData;
    k.animation = animations.findIndex((a) => a.name === animName);
    if (k.animation < 0) { skip(`slider "${k.name}" plays the animation "${animName}", which is not there; it does nothing`, { kind: "constraint", type: "slider", name: k.name }); continue; }
    k.bones = [...new Set(animations[k.animation]!.timelines.flatMap((t) => (t.kind === "bone" || t.kind === "inherit" ? [t.bone] : [])))];
  }

  return {
    bones, slots, constraints, skins, animations,
    // Absent stays 0, as the runtime leaves it; the timeline shows 30 then (SPEC §2).
    fps: num(obj(file.skeleton).fps, 0),
    referenceScale: num(obj(file.skeleton).referenceScale, 100),
    skipped: [...skipped.values()],
  };
}

