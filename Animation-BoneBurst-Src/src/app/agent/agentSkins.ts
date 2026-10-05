import type { CnId, IkId, ItemId, TcId } from "@/core/doc/ids";
import { displaysOf } from "@/core/doc/displays";
import { applySkins, doSetSkinImage, doSetSkinMembers, doSetSkinOnly } from "@/app/SkinOps";
import { withNewSkin, withSkinColor } from "@/core/doc/skins";
import { skinsOf, stageSkinOf } from "@/core/boneburst/boneburstPose";
import { AgentError, list, str, type Args } from "./agentArgs";
import type { AgentApi } from "./AgentApi";

/**
 * The AI's skin tools.
 */

export function skinNamed(api: AgentApi, name: string): string {
  const named = skinsOf(api.sym).filter((n) => n !== "default");
  if (!named.includes(name)) throw new AgentError(`There is no skin "${name}"; the rig has ${named.length ? named.join(", ") : "none"} (add_skin makes one).`);
  return name;
}

export function addSkin(api: AgentApi, name: string) {
  const refused = applySkins(api.store, "AI: New Skin", withNewSkin(api.sym, name));
  if (refused) throw new AgentError(refused);
  return { skins: skinsOf(api.sym).filter((n) => n !== "default"), showing: stageSkinOf(api.sym) };
}

/** A skin's colour in Spine's editor: "rrggbb" or "rrggbbaa", null for Spine's default. */
export function setSkinColor(api: AgentApi, name: string, color: unknown) {
  const skin = skinNamed(api, name);
  if (color !== null && (typeof color !== "string" || !/^#?[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color))) throw new AgentError(`color is "rrggbb" or "rrggbbaa", or null for Spine's default.`);
  const hex = typeof color === "string" ? color.replace("#", "") : null;
  const refused = applySkins(api.store, `AI: Skin Colour "${skin}"`, withSkinColor(api.sym, skin, hex ? (hex.length === 6 ? `${hex}ff` : hex) : undefined));
  if (refused) throw new AgentError(refused);
  return { skin, color: api.sym.skins?.find((d) => d.name === skin)?.color ?? null };
}

export function setSkinImage(api: AgentApi, args: Args) {
  const skin = skinNamed(api, str(args, "skin"));
  const layer = api.node(str(args, "layer"));
  const count = displaysOf(layer).length;
  if (!count) throw new AgentError(`"${layer.name}" shows no image, so a skin has nothing to put in its place.`);
  const index = args.display === undefined ? 0 : Number(args.display);
  if (!Number.isInteger(index) || index < 0 || index >= count) throw new AgentError(`"${layer.name}" has displays 0 to ${count - 1}.`);
  let itemId: ItemId | null = null;
  if (args.image !== null && args.image !== undefined) {
    const item = api.libraryImages().find((i) => i.name === args.image);
    if (!item) throw new AgentError(`There is no image "${String(args.image)}" in the library.`);
    itemId = item.id;
  }
  api.store.history.transaction("AI: Skin Image", () => {
    if (args.image !== undefined) {
      const refused = doSetSkinImage(api.store, skin, layer.id, index, itemId, "AI: Skin Image");
      if (refused) throw new AgentError(refused);
    }
    if (typeof args.only_in_skins === "boolean" && !!displaysOf(api.sym.nodes[layer.id]!)[index]!.skinOnly !== args.only_in_skins) {
      doSetSkinOnly(api.store, layer.id, index, args.only_in_skins);
    }
  });
  const ref = api.sym.skins?.find((d) => d.name === skin)?.displays?.[layer.id]?.[String(index)];
  return { skin, layer: layer.name, display: index, image: ref ? api.store.project.items[ref.itemId]?.name ?? null : null, onlyInSkins: !!displaysOf(api.sym.nodes[layer.id]!)[index]!.skinOnly };
}

export function setSkinMembers(api: AgentApi, args: Args) {
  const skin = skinNamed(api, str(args, "skin"));
  const bones = args.bones === undefined ? [] : list<string>(args, "bones").map((n) => api.bone(n).id);
  const names = args.constraints === undefined ? [] : list<string>(args, "constraints");
  const ik: IkId[] = [], transforms: TcId[] = [], constraints: CnId[] = [];
  const others = [...(api.sym.physics ?? []), ...(api.sym.sliders ?? []), ...(api.sym.paths ?? [])];
  for (const n of names) {
    const k = api.sym.ik.find((c) => c.name === n), t = (api.sym.transforms ?? []).find((c) => c.name === n), o = others.find((c) => c.name === n);
    if (k) ik.push(k.id); else if (t) transforms.push(t.id); else if (o) constraints.push(o.id);
    else throw new AgentError(`There is no constraint "${n}". get_rig lists them in constraintOrder.`);
  }
  const refused = doSetSkinMembers(api.store, skin, { bones, ik, transforms, constraints }, args.remove !== true, "AI: Skin Members");
  if (refused) throw new AgentError(refused);
  const def = api.sym.skins?.find((d) => d.name === skin);
  return {
    skin,
    bones: (def?.bones ?? []).map((id) => api.sym.nodes[id]?.name),
    constraints: [
      ...(def?.ik ?? []).map((id) => api.sym.ik.find((c) => c.id === id)?.name),
      ...(def?.transforms ?? []).map((id) => api.sym.transforms?.find((c) => c.id === id)?.name),
      ...(def?.constraints ?? []).map((id) => others.find((c) => c.id === id)?.name),
    ],
  };
}
