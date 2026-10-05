import { eventDefsFromBoneBurst } from "./events";
import { BLEND_MODES, type BlendMode, DOC_VERSION } from "./types";

/**
 * Version bridge: step N turns a version-N document into version N + 1.
 * Most steps only move the version (the change was additive, and the bump
 * makes an older build refuse the file rather than drop what it cannot read).
 */
export const MIGRATIONS: Record<number, (p: Record<string, unknown>) => Record<string, unknown>> = {
  // 0 -> 1: files written before the version field existed.
  0: (p) => ({ ...p, version: 1 }),
  // 1 -> 2: mask layers. Purely additive — an absent `isMask`/`maskedBy`
  // reads as "no masks" — but the version moves so an older build refuses
  // the file rather than opening it and silently drawing without the clip.
  1: (p) => ({ ...p, version: 2 }),
  // 2 -> 3: `Layer.excludeFromExport` and the "empty" node kind. Additive
  // again, and again the version moves: an older build would happily export
  // the very content the user marked as excluded.
  2: (p) => ({ ...p, version: 3 }),
  // 3 -> 4: motion blur (`Project.motionBlur`, `Node.motionBlur`). Additive;
  // an older build would drop the settings on save without saying so.
  3: (p) => ({ ...p, version: 4 }),
  // 4 -> 5: preset and multi-segment eases, per-property `Keyframe.eases`.
  // An older build has no evaluator for either and would tween to NaN.
  4: (p) => ({ ...p, version: 5 }),
  // 5 -> 6: `Node.extraDisplays`, artwork switched per keyframe. An older
  // build would draw display 0 on every key and export it that way.
  5: (p) => ({ ...p, version: 6 }),
  // 6 -> 7: `Project.exportSettings`. Additive; an older build would export
  // at its own defaults and drop the settings on save.
  6: (p) => ({ ...p, version: 7 }),
  // 7 -> 8: Spine files opened for editing (`SymbolItem.spine`, slots on
  // bones, `Animation.endsAtLastFrame`). The DragonBones-era inherit flags,
  // which nothing drew or exported, give way to Spine's `inherit`.
  7: (p) => {
    for (const item of Object.values((p.items ?? {}) as Record<string, { nodes?: Record<string, Record<string, unknown>>; }>)) {
      for (const node of Object.values(item?.nodes ?? {})) {
        delete node.inheritRotation;
        delete node.inheritScale;
      }
    }
    return { ...p, version: 8 };
  },
  // 8 -> 9: eases per axis (`Keyframe.eases` x, y, scaleX, scaleY, shear).
  // Additive; an older build would drop them and play both axes on one ease.
  8: (p) => ({ ...p, version: 9 }),
  // 9 -> 10: `Animation.reference`, reference art saved in the file. An
  // older build would keep the field and drop its images on the next save.
  9: (p) => ({ ...p, version: 10 }),
  // 10 -> 11: `AnimationReference.at`, the frame each picture is keyed to.
  // Additive (the reader re-derives it from start/hold when absent), but the
  // version moves: an older build would drop it on save and re-space the
  // pictures evenly.
  10: (p) => ({ ...p, version: 11 }),
  // 11 -> 12: `Animation.poses`, the user's key-pose frames. Additive; an
  // older build would drop the list on save without saying so.
  11: (p) => ({ ...p, version: 12 }),
  // 12 -> 13: `Node.pathDrag`, how dragging a bone's path turns it. Additive;
  // an older build would drop it on save.
  12: (p) => ({ ...p, version: 13 }),
  // 13 -> 14: `Node.primary`, a bone the stage toolbar's Primary row governs.
  // Additive; an older build would drop it on save.
  13: (p) => ({ ...p, version: 14 }),
  // 14 -> 15: `Keyframe.keyed`, which bone properties a key is a key of on
  // the timeline's property rows. Additive; an older build would drop it.
  14: (p) => ({ ...p, version: 15 }),
  // 15 -> 16: `Animation.drawOrder`, draw order keys. Additive; an older
  // build would drop them on save.
  15: (p) => ({ ...p, version: 16 }),
  // 16 -> 17: `Animation.ik`, IK mix and bend keys. Additive; an older build
  // would drop them on save.
  16: (p) => ({ ...p, version: 17 }),
  // 17 -> 18: `IkConstraint.softness` and `IkKey.softness`. An opened
  // constraint carried its softness in `spine`; it moves to the field the
  // solver reads.
  17: (p) => {
    const items = (p.items ?? {}) as Record<string, { ik?: Array<{ softness?: unknown; spine?: Record<string, unknown>; }>; }>;
    for (const item of Object.values(items)) {
      for (const k of item.ik ?? []) {
        if (!k.spine || !("softness" in k.spine)) continue;
        const { softness, ...rest } = k.spine;
        k.softness = softness;
        if (Object.keys(rest).length) k.spine = rest;
        else delete k.spine;
      }
    }
    return { ...p, version: 18 };
  },
  // 18 -> 19: `SymbolItem.events` and `Animation.events`. An opened file's
  // events were carried in `spine.events`; they move to the list the editor
  // edits (an animation's carried keys stay carried, naming them).
  18: (p) => {
    const items = (p.items ?? {}) as Record<string, { events?: unknown; spine?: Record<string, unknown>; }>;
    for (const item of Object.values(items)) {
      const carried = item.spine?.events;
      if (!carried || typeof carried !== "object" || item.events) continue;
      item.events = eventDefsFromBoneBurst(carried as Record<string, unknown>);
      delete item.spine!.events;
    }
    return { ...p, version: 19 };
  },
  // 19 -> 20: `SymbolItem.transforms` and `Animation.transforms`, transform
  // constraints and their keys. Additive; an older build would drop them.
  19: (p) => ({ ...p, version: 20 }),
  // 20 -> 21: `MeshData` on displays (`Node.mesh`, `DisplayRef.mesh`) and
  // `Animation.deforms`. Additive; an older build would drop them.
  20: (p) => ({ ...p, version: 21 }),
  21: (p) => ({ ...p, version: 22 }),
  22: (p) => ({ ...p, version: 23 }),
  // 23 -> 24: `SymbolItem.constraintOrder`, which an opened file's order
  // moves to from `spine.constraintOrder`.
  23: (p) => {
    const items = (p.items ?? {}) as Record<string, { constraintOrder?: unknown; spine?: Record<string, unknown>; }>;
    for (const item of Object.values(items)) {
      if (!item.spine || !("constraintOrder" in item.spine)) continue;
      item.constraintOrder ??= item.spine.constraintOrder;
      delete item.spine.constraintOrder;
    }
    return { ...p, version: 24 };
  },
  // 24 -> 25: `Animation.inherits` and `Animation.constraintKeys`, inherit
  // mode keys and physics, slider and path constraint keys, additive; a bone's
  // carried `icon` moves to `Node.boneIcon`.
  24: (p) => {
    const items = (p.items ?? {}) as Record<string, { nodes?: Record<string, { boneIcon?: unknown; spine?: { bone?: Record<string, unknown>; }; }>; }>;
    for (const item of Object.values(items)) {
      for (const node of Object.values(item.nodes ?? {})) {
        const bone = node.spine?.bone;
        if (!bone || typeof bone.icon !== "string") continue;
        node.boneIcon ??= bone.icon;
        const { icon: _i, ...rest } = bone;
        if (Object.keys(rest).length) node.spine!.bone = rest; else delete node.spine!.bone;
      }
    }
    return { ...p, version: 25 };
  },
  // 25 -> 26: points with an offset, turned sequence regions, weighted boxes
  // and paths, skins' meshes and links to another skin's mesh. Additive; an
  // older build would drop them.
  25: (p) => ({ ...p, version: 26 }),
  // 26 -> 27: attachment tints, deform keys of any display in any skin,
  // opened path constraints. Additive; an older build would drop them.
  26: (p) => ({ ...p, version: 27 }),
  // 27 -> 28: motion blur and the five blend modes Spine lacks are gone. Nothing
  // drew the blur outside Animo's runtime, and the export wrote those modes as
  // normal; both are dropped, so the stage shows what the export writes.
  27: (p) => {
    delete p.motionBlur;
    const items = (p.items ?? {}) as Record<string, { nodes?: Record<string, Record<string, unknown>>; }>;
    for (const item of Object.values(items)) {
      for (const node of Object.values(item.nodes ?? {})) {
        delete node.motionBlur;
        if (node.blendMode !== undefined && !BLEND_MODES.has(node.blendMode as BlendMode)) delete node.blendMode;
      }
    }
    return { ...p, version: 28 };
  },
};
export function migrate(raw: unknown): unknown {
  let p = raw as Record<string, unknown>;
  let version = typeof p?.version === "number" ? p.version : 0;
  while (version < DOC_VERSION) {
    const step = MIGRATIONS[version];
    if (!step) break;
    p = step(p);
    version = typeof p.version === "number" ? p.version : version + 1;
  }
  return p;
}
