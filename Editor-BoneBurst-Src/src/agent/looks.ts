import { addAttachment, type AttachmentRef, deleteAttachment, findAttachment, replaceAttachment, updateAttachment } from "@/edit/attachments";
import { updateBone } from "@/edit/bones";
import { type ConstraintPatch, updateConstraint } from "@/edit/constraints";
import type { Edit } from "@/edit/history";
import { addSkin, setSkinColor, setSkinMember, type SkinList } from "@/edit/skins";
import { type Attachment, attachmentType, type Skeleton } from "@/model/skeleton";
import { applyEdit } from "./apply";
import { type AgentContext, AgentRefused } from "./context";
import { docOf } from "./read";
import { colourOf, displayKey, entryOf, imageOf, shownEntry, slotNamed } from "./where";

/**
 * How the rig looks (E5-PLAN step 8): skins (made, given images, coloured, given bones and
 * constraints of their own) and attachment tints. Each call is one History step "AI: …".
 */

type Args = Record<string, unknown>;

function skinNamed(doc: Skeleton, name: unknown) {
  const k = doc.skins?.find((x) => x.name === name);
  if (!k) throw new AgentRefused(`There is no skin "${String(name)}"; get_rig lists the skins.`);
  return k;
}

const skinNames = (doc: Skeleton) => (doc.skins ?? []).map((k) => k.name);

function addSkinTool(args: Args, ctx: AgentContext) {
  const name = String(args.name);
  applyEdit(ctx, `add_skin ${name}`, addSkin(name));
  ctx.show({ ...ctx.view(), skin: name });
  return { skin: name, skins: skinNames(docOf(ctx)), shown: name };
}

/** The attachment a skin shows in place of the one at `like`: `image` about the same centre, turn and scale; in a mesh's place, a linked mesh of it. */
function inPlaceOf(doc: Skeleton, like: AttachmentRef, image: string, ctx: AgentContext): Attachment {
  const a = findAttachment(doc, like)!, type = attachmentType(a);
  if (type === "linkedmesh" && a.source !== undefined) return inPlaceOf(doc, { skin: a.skin ?? "default", slot: like.slot, key: a.source }, image, ctx);
  if (type === "mesh") return { type: "linkedmesh", name: image, source: like.key, ...(like.skin !== "default" ? { skin: like.skin } : {}), extra: new Map() } as Attachment;
  if (type !== "region") throw new AgentRefused(`"${like.key}" is a ${type}, not an image: a skin's image takes the place of a region or a mesh.`);
  const want = ctx.images.regions.find((r) => r.name === image)!;
  const was = ctx.images.regions.find((r) => r.name === imageOf(a, like.key));
  // The image at the size the slot's own image is drawn at, relative to its own pixels.
  const kx = was && was.originalWidth ? (a.width ?? was.originalWidth) / was.originalWidth : 1;
  const ky = was && was.originalHeight ? (a.height ?? was.originalHeight) / was.originalHeight : 1;
  const { name: _n, path: _p, sequence: _s, width: _w, height: _h, extra: _e, ...place } = a;
  return { ...place, name: image, width: want.originalWidth * kx, height: want.originalHeight * ky, extra: new Map() } as Attachment;
}

function setSkinImage(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), skin = skinNamed(doc, args.skin).name, slot = slotNamed(doc, args.layer).name;
  if (skin === "default") throw new AgentRefused("The default skin is the slot's own image: attach changes it. set_skin_image is for the other skins.");
  const key = displayKey(doc, slot, args.display), image = args.image as string | null | undefined;
  const r = { skin, slot, key }, has = findAttachment(doc, r);
  const edits: Edit<Skeleton>[] = [];
  if (image === null || image === undefined) {
    if (!has) return { skin, layer: slot, display: key, image: null, note: `"${skin}" had no image of its own for "${key}".` };
    edits.push(deleteAttachment(r));
  } else {
    if (!ctx.images.regions.some((x) => x.name === image)) throw new AgentRefused(`There is no atlas image "${image}"; get_rig lists the images.`);
    // Placed like the display as the default skin draws it, else as another skin does, else as this skin did.
    const likeSkin = ["default", ...skinNames(doc)].find((n) => n !== skin && entryOf(doc, n, slot, key)) ?? skin;
    const a = inPlaceOf(doc, { skin: likeSkin, slot, key }, image, ctx);
    edits.push(has ? (s) => replaceAttachment(s, r, a) : addAttachment(r, a));
  }
  if (args.only_in_skins === true && entryOf(doc, "default", slot, key)) edits.push(deleteAttachment({ skin: "default", slot, key }));
  applyEdit(ctx, `set_skin_image ${skin} ${slot}`, (s) => edits.reduce((d, e) => e(d), s));
  return { skin, layer: slot, display: key, image: image ?? null, inDefaultSkin: !!entryOf(docOf(ctx), "default", slot, key) };
}

function setSkinColorTool(args: Args, ctx: AgentContext) {
  const skin = skinNamed(docOf(ctx), args.skin).name, color = colourOf(args.color, false);
  applyEdit(ctx, `set_skin_color ${skin}`, setSkinColor(skin, color));
  return { skin, color: color ?? null };
}

function setSkinMembers(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), skin = skinNamed(doc, args.skin).name, on = args.remove !== true;
  const members: { list: SkinList; name: string }[] = ((args.bones ?? []) as string[]).map((name) => ({ list: "bones" as const, name }));
  for (const name of (args.constraints ?? []) as string[]) {
    const c = doc.constraints?.find((x) => x.name === name);
    if (!c) throw new AgentRefused(`There is no constraint "${name}"; get_rig lists the constraints.`);
    members.push({ list: c.type as SkinList, name });
  }
  if (!members.length) throw new AgentRefused("Name some `bones` or `constraints`.");
  // A member is skin-required (Spine's `skin: true`): without the flag a skin's list turns nothing off.
  // Taken out of the last skin listing it, it is no longer required, so it is on again.
  const required = (list: SkinList, name: string, flag: boolean): Edit<Skeleton> => (list === "bones"
    ? updateBone(name, { skin: flag ? true : undefined })
    : updateConstraint({ type: list, name }, { skin: flag ? true : undefined } as ConstraintPatch));
  applyEdit(ctx, `set_skin_members ${skin}`, (s) => members.reduce((d, m) => {
    const next = setSkinMember(skin, m.list, m.name, on)(d);
    const listed = next.skins?.some((k) => k[m.list]?.includes(m.name)) ?? false;
    return required(m.list, m.name, listed)(next);
  }, s));
  const k = skinNamed(docOf(ctx), skin);
  return { skin, bones: k.bones ?? [], constraints: [...(k.ik ?? []), ...(k.transform ?? []), ...(k.path ?? []), ...(k.physics ?? []), ...(k.slider ?? [])] };
}

function setTint(args: Args, ctx: AgentContext) {
  const doc = docOf(ctx), slot = slotNamed(doc, args.layer).name, key = displayKey(doc, slot, args.display);
  const r = shownEntry(doc, ctx, slot, key), color = colourOf(args.color);
  applyEdit(ctx, `set_tint ${slot}`, updateAttachment(r, { color }));
  return { layer: slot, display: key, skin: r.skin, color: color ?? null };
}

export const LOOK_TOOLS = {
  add_skin: addSkinTool,
  set_skin_image: setSkinImage,
  set_skin_color: setSkinColorTool,
  set_skin_members: setSkinMembers,
  set_tint: setTint,
} as const;
