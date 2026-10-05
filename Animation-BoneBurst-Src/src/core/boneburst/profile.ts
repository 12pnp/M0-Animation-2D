/**
 * The BoneBurst profile of Spine 4.3 JSON (`Packages/com.module.ta-creator-boneburst/
 * Doc/Format/BoneBurst-Profile.md` in M0-Animation-2D): what a file must hold so both
 * BoneBurst runtimes, this editor's and the Unity packages', read it the same way.
 * `profileIssues` lists what breaks it, each in words close to the error Unity's
 * `SkeletonJsonReader` throws, so an export that fails here would fail there too.
 * Timeline names are matched exactly (the reader's switch is case-sensitive) and an
 * unknown one is an issue, though both readers skip it without a word: that silent
 * drop is what the profile exists to catch.
 * Pure; `tests/boneburstProfile.test.ts` holds every export and sample to it.
 */

type Json = Record<string, unknown>;

const CONSTRAINT_TYPES = new Set(["ik", "transform", "path", "physics", "slider"]);
const ATTACHMENT_TYPES = new Set(["region", "mesh", "linkedmesh", "boundingbox", "path", "point", "clipping"]);
const TRANSFORM_PROPERTIES = new Set(["rotate", "x", "y", "scaleX", "scaleY", "shearY"]);
const BLENDS = new Set(["normal", "additive", "multiply", "screen"]);
const INHERITS = new Set(["normal", "onlytranslation", "norotationorreflection", "noscale", "noscaleorreflection"]);
const BONE_TIMELINES = new Set(["rotate", "translate", "translatex", "translatey", "scale", "scalex", "scaley", "shear", "shearx", "sheary", "inherit"]);
const SLOT_TIMELINES = new Set(["attachment", "rgba", "rgb", "alpha", "rgba2", "rgb2"]);
const ATTACHMENT_TIMELINES = new Set(["deform", "sequence"]);
const ANIMATION_SECTIONS = new Set(["bones", "slots", "ik", "transform", "path", "physics", "slider", "attachments", "drawOrder", "drawOrderFolder", "events"]);

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): Json[] => (Array.isArray(v) ? v.filter(isObj) : []);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * What breaks the profile. `written`: the file is one a BoneBurst writer made (the
 * editor's export), which must also carry what an artist's file may leave out: the hash.
 */
export function profileIssues(file: unknown, { written = false } = {}): string[] {
  const out: string[] = [];
  if (!isObj(file)) return ["JSON skeleton root is not an object"];

  const header = file.skeleton;
  if (!isObj(header)) out.push('no "skeleton" header, so its Spine version is unknown');
  else {
    const version = str(header.spine);
    if (!version?.startsWith("4.3")) out.push(`version ${version ?? "(none)"}: BoneBurst reads Spine 4.3 only`);
    if (written) {
      // Stock spine-csharp requires the hash; spine-core and BoneBurst's readers do not.
      // (`fps` is nonessential: readers default it differently, spine-csharp and
      // BoneBurst's C# reader 30, spine-core 0, and no playback reads it.)
      if (!str(header.hash)) out.push('header has no "hash"');
    }
  }

  const bones = new Set<string>();
  for (const b of list(file.bones)) {
    const name = str(b.name);
    if (!name) { out.push("a bone has no name"); continue; }
    const parent = str(b.parent);
    if (parent !== undefined && !bones.has(parent)) out.push(`bone "${name}": parent bone not found (or not before it): ${parent}`);
    if (bones.has(name)) out.push(`bone "${name}" named twice`);
    if (b.inherit !== undefined && !INHERITS.has(String(b.inherit).toLowerCase())) out.push(`bone "${name}": unknown inherit "${String(b.inherit)}"`);
    bones.add(name);
  }
  if (!bones.size) out.push("no bones");

  const slots = new Set<string>();
  for (const s of list(file.slots)) {
    const name = str(s.name);
    if (!name) { out.push("a slot has no name"); continue; }
    if (!bones.has(str(s.bone) ?? "")) out.push(`slot "${name}": slot bone not found: ${String(s.bone)}`);
    if (s.blend !== undefined && !BLENDS.has(String(s.blend).toLowerCase())) out.push(`slot "${name}": unknown blend "${String(s.blend)}"`);
    if (slots.has(name)) out.push(`slot "${name}" named twice`);
    slots.add(name);
  }

  const constraints = new Map<string, string>();
  const animations = isObj(file.animations) ? file.animations : {};
  for (const k of list(file.constraints)) {
    const name = str(k.name) ?? "(unnamed)", type = str(k.type) ?? "";
    if (!CONSTRAINT_TYPES.has(type)) { out.push(`constraint "${name}": unknown constraint type '${type}'`); continue; }
    constraints.set(name, type);
    const refs = [...(Array.isArray(k.bones) ? k.bones : []), k.target, k.source, k.bone].filter((r) => r !== undefined);
    for (const r of refs) if (!bones.has(String(r))) out.push(`${type} constraint "${name}": bone not found: ${String(r)}`);
    if (type === "path" && !slots.has(str(k.slot) ?? "")) out.push(`path constraint "${name}": slot not found: ${String(k.slot)}`);
    if (type === "slider" && k.animation !== undefined && !(String(k.animation) in animations)) out.push(`slider '${name}' animation not found: ${String(k.animation)}`);
    if (type === "transform" && isObj(k.properties)) {
      for (const [from, map] of Object.entries(k.properties)) {
        if (!TRANSFORM_PROPERTIES.has(from)) out.push(`transform constraint "${name}": unknown transform property '${from}'`);
        const to = isObj(map) && isObj(map.to) ? Object.keys(map.to) : [];
        for (const t of to) if (!TRANSFORM_PROPERTIES.has(t)) out.push(`transform constraint "${name}": unknown transform property '${t}'`);
      }
    }
  }

  // Attachments by skin, then slot, then name; linked meshes resolved after all skins.
  const skinNames = new Set<string>();
  const attachments = new Map<string, Json>();
  const links: Array<{ where: string; skin: string; slot: string; source: string }> = [];
  for (const skin of list(file.skins)) {
    const skinName = str(skin.name) ?? "default";
    skinNames.add(skinName);
    const bySlot = isObj(skin.attachments) ? skin.attachments : {};
    for (const [slot, entries] of Object.entries(bySlot)) {
      if (!slots.has(slot)) out.push(`skin "${skinName}": slot not found: ${slot}`);
      for (const [key, att] of Object.entries(isObj(entries) ? entries : {})) {
        if (!isObj(att)) continue;
        const type = str(att.type) ?? "region", where = `skin "${skinName}" slot "${slot}" attachment "${key}"`;
        attachments.set(`${skinName}\u0000${slot}\u0000${key}`, att);
        if (!ATTACHMENT_TYPES.has(type)) { out.push(`${where}: unknown attachment type '${type}'`); continue; }
        // Linked when it names a `source`, whatever its type says (Format-Json-Atlas.md
        // §8.4); a "linkedmesh" without one is read as a plain mesh, and fails as one.
        const linked = (type === "mesh" || type === "linkedmesh") && str(att.source) !== undefined;
        if (linked) {
          links.push({ where, skin: str(att.skin) ?? "default", slot: str(att.slot) ?? slot, source: str(att.source)! });
          continue;
        }
        if (type === "mesh" || type === "linkedmesh") {
          if (!Array.isArray(att.uvs)) out.push(`${where}: mesh has no uvs`);
          if (!Array.isArray(att.triangles)) out.push(`${where}: mesh has no triangles`);
        }
        if ((type === "mesh" || type === "linkedmesh" || type === "boundingbox" || type === "path" || type === "clipping") && !Array.isArray(att.vertices)) out.push(`${where}: has no vertices`);
        if (type === "path" && !Array.isArray(att.lengths)) out.push(`${where}: path has no lengths`);
        if (type === "clipping" && att.end !== undefined && !slots.has(String(att.end))) out.push(`${where}: clipping end slot not found: ${String(att.end)}`);
      }
    }
  }
  for (const l of links) {
    if (!skinNames.has(l.skin)) out.push(`${l.where}: linked mesh skin not found: ${l.skin}`);
    else if (!slots.has(l.slot)) out.push(`${l.where}: linked mesh slot not found: ${l.slot}`);
    else if (!attachments.has(`${l.skin}\u0000${l.slot}\u0000${l.source}`)) out.push(`${l.where}: source mesh not found: ${l.source}`);
  }

  const events = isObj(file.events) ? file.events : {};
  for (const [animName, anim] of Object.entries(animations)) {
    if (!isObj(anim)) continue;
    const at = (what: string) => `animation "${animName}": ${what}`;
    for (const section of Object.keys(anim)) if (!ANIMATION_SECTIONS.has(section)) out.push(at(`unknown section "${section}"`));
    for (const [bone, tls] of Object.entries(isObj(anim.bones) ? anim.bones : {})) {
      if (!bones.has(bone)) out.push(at(`bone not found: ${bone}`));
      for (const t of Object.keys(isObj(tls) ? tls : {})) if (!BONE_TIMELINES.has(t)) out.push(at(`bone "${bone}": unknown timeline "${t}"`));
    }
    for (const [slot, tls] of Object.entries(isObj(anim.slots) ? anim.slots : {})) {
      if (!slots.has(slot)) out.push(at(`slot not found: ${slot}`));
      for (const t of Object.keys(isObj(tls) ? tls : {})) if (!SLOT_TIMELINES.has(t)) out.push(at(`slot "${slot}": unknown timeline "${t}"`));
    }
    for (const type of ["ik", "transform", "path", "physics", "slider"] as const) {
      for (const name of Object.keys(isObj(anim[type]) ? (anim[type] as Json) : {})) {
        // Physics keys under "" drive every physics constraint at once.
        if (type === "physics" && name === "") continue;
        if (constraints.get(name) !== type) out.push(at(`${type} constraint not found: ${name}`));
      }
    }
    for (const [skin, bySlot] of Object.entries(isObj(anim.attachments) ? anim.attachments : {})) {
      if (!skinNames.has(skin)) out.push(at(`skin not found: ${skin}`));
      for (const [slot, byAtt] of Object.entries(isObj(bySlot) ? bySlot : {})) {
        for (const [key, tls] of Object.entries(isObj(byAtt) ? byAtt : {})) {
          if (!attachments.has(`${skin}\u0000${slot}\u0000${key}`)) out.push(at(`timeline attachment not found: ${key} (skin "${skin}", slot "${slot}")`));
          for (const t of Object.keys(isObj(tls) ? tls : {})) if (!ATTACHMENT_TIMELINES.has(t)) out.push(at(`attachment "${key}": unknown timeline "${t}"`));
        }
      }
    }
    for (const key of list(anim.drawOrder)) {
      for (const o of list(key.offsets)) if (!slots.has(str(o.slot) ?? "")) out.push(at(`draw order: slot not found: ${String(o.slot)}`));
    }
    for (const key of list(anim.events)) {
      if (!(String(key.name) in events)) out.push(at(`event not found: ${String(key.name)}`));
    }
  }
  return out;
}
