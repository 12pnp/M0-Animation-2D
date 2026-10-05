# Skins (Spine parity, phase E)

Done (2026-10-05): ARCHITECTURE ▸ Skins. Checked in Unity in phase H (ARCHITECTURE ▸ Checked in Unity).

docs/SPINE-PARITY-PLAN.md ▸ Phase E. One skeleton, several characters or outfits: a skin puts
its own image in a slot's place, and some bones and constraints exist only in the skins that
list them. Today the stage and Preview pick among an opened file's skins, carried whole; nothing
here makes or edits one.

## The model

```ts
interface SkinDef {
  name: string;                                        // unique, never "default"
  displays?: Record<NodeId, Record<string, DisplayRef>>; // node → display index → what the skin shows there
  bones?: NodeId[];                                    // skin bones: active only while a skin listing them is shown
  ik?: IkId[];
  transforms?: TcId[];
}
SymbolItem.skins?: SkinDef[]
DisplayRef.skinOnly?: true   // the default skin leaves this display empty (Spine's skin placeholder);
Node.skinOnly?: true         //   display 0's flag, as `displayZero` copies the node's fields
```

The default skin is the node's displays, as today. **A display index is the placeholder**: its
attachment key (the image name the exporter gives it) is what attachment keys name, and a skin
that overrides that index writes its own attachment under the same slot and key. Displays are
only ever appended or swapped, so the indices hold.

## Rules, as spine-core 4.3 has them (checked against it)

- **What a slot shows**: the shown skins in order, the last one holding the key winning
  (`Skin.addSkin`), else the default skin; a `skinOnly` display with no skin holding it shows
  nothing.
- **Skin bones** (`Skeleton.updateCache`): a bone some skin lists is inactive unless a shown skin
  lists it or one of its descendants. An inactive bone's slots are not drawn. The export also
  lists every non-bone descendant (an image's own bone) of a listed node, so its slot goes with
  it; adding a bone to a skin in the UI adds its descendant bones.
- **Skin constraints**: active when the source is (an IK's target, a transform constraint's
  source) and, when some skin lists it, a shown skin does.
- **Bind poses** for weighted meshes are evaluated with every bone and constraint active (no
  skin rules), by the stage and the exporter alike, so the two agree.

## Steps

1. **Core**: `core/doc/skins.ts` (pure): skin names, the stage's choice (`stageSkinOf` moves
   here), `skinnedDisplay`, `skinActivity`, plans to add, rename, remove a skin, set a skin's
   image for a display, add and remove members. `evaluateSymbol` takes the shown skins.
   Schema 22.
2. **Export**: each skin's attachments, bones and constraints (`skin: true` on them); skin-only
   displays keep their key out of the default skin. Parity against spine-core with skins shown:
   attachments, world corners, inactive bones' slots, skin constraints.
3. **Import**: an opened file's skins become model skins: a region or mesh under a key the
   default skin has overrides that display; under a key it lacks, a skin-only display; bones
   and modelled constraints become members. What the model cannot hold stays carried, merged
   back by skin name. `spineImport` keeps every sample round-tripping.
4. **UI**: Skins panel: New, Rename, Delete, show; Properties ▸ Skins on an image (the skin's
   image for each display, Only in skins) and on a bone (in which skins; its constraints).
   AI tools `add_skin`, `set_skin_image`, `set_skin_members`.
5. **Docs**: ARCHITECTURE ▸ Skins.

## Out of scope for now

- Skin colours, skin folders' own UI (names with "/" still group), per-skin deform keys and a
  mesh made for a skin image (an override is a region, or the opened attachment it came with).
- Nested symbols' skins: only the exported symbol's skins are written; a nested one warns.
