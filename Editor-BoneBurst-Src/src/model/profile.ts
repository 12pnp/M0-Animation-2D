import type { Issue } from "./issue";
import { ATTACHMENT_TYPES, type Constraint, type ConstraintType, type Skeleton, attachmentType } from "./skeleton";

/**
 * The BoneBurst profile of Spine 4.3 JSON (Doc/Format/BoneBurst-Profile.md): what both BoneBurst
 * readers require of a file (§1), and with `written`, what a file this editor writes must also
 * hold (§2). Each broken rule is one issue; an empty list is a file both runtimes read.
 */
export function profileIssues(s: Skeleton, opts: { written?: boolean } = {}): Issue[] {
  const out: Issue[] = [];
  const bad = (where: string, message: string) => out.push({ where, message });

  const version = s.header?.spine;
  if (!s.header) bad("skeleton", "no skeleton header");
  else if (typeof version !== "string" || !version.startsWith("4.3")) bad("skeleton/spine", `Spine ${version ?? "(no version)"}; BoneBurst reads 4.3 only`);
  if (opts.written) {
    if (s.header?.hash === undefined) bad("skeleton/hash", "no hash (spine-csharp requires it)");
    if (version !== "4.3.0") bad("skeleton/spine", `written as ${version ?? "nothing"}; a written file says 4.3.0`);
  }

  // Sections the model could not hold are carried in `extra`: still files, but not checkable here.
  for (const k of ["bones", "slots", "constraints", "skins", "events", "animations"]) {
    if (s.extra.has(k)) bad(k, "kept as written, not checked: the model could not read it");
  }

  const bones = new Set<string>();
  for (const [i, b] of (s.bones ?? []).entries()) {
    if (b.parent !== undefined && !bones.has(b.parent)) bad(`bones[${i}]`, `"${b.name}": parent "${b.parent}" is not an earlier bone`);
    bones.add(b.name);
  }
  const boneRef = (where: string, name: string | undefined, what: string) => {
    if (name !== undefined && !bones.has(name)) bad(where, `${what} "${name}" is not a bone`);
  };

  const slots = new Set<string>();
  for (const [i, sl] of (s.slots ?? []).entries()) {
    boneRef(`slots[${i}]`, sl.bone, `"${sl.name}": bone`);
    slots.add(sl.name);
  }

  const byKind = new Map<ConstraintType, Set<string>>();
  for (const [i, c] of (s.constraints ?? []).entries()) {
    const where = `constraints[${i}]`;
    constraintRefs(c, where, boneRef, slots, bad);
    if (!byKind.has(c.type)) byKind.set(c.type, new Set());
    byKind.get(c.type)!.add(c.name);
  }
  const animations = new Set((s.animations ?? []).map((a) => a.name));
  for (const [i, c] of (s.constraints ?? []).entries()) {
    if (c.type === "slider" && c.animation !== undefined && !animations.has(c.animation)) bad(`constraints[${i}]`, `"${c.name}": animation "${c.animation}" does not exist`);
  }

  // Skins: what they list exists; attachments are known kinds; meshes are whole; links resolve.
  const skinAtt = (skin: string, slot: string, key: string) =>
    s.skins?.find((k) => k.name === skin)?.attachments?.find((e) => e.slot === slot)?.entries.find((e) => e.key === key)?.attachment;
  for (const sk of s.skins ?? []) {
    const where = `skins/${sk.name}`;
    for (const b of sk.bones ?? []) boneRef(where, b, "listed");
    for (const kind of ["ik", "transform", "path", "physics", "slider"] as const) {
      for (const n of sk[kind] ?? []) if (!byKind.get(kind)?.has(n)) bad(where, `${kind} constraint "${n}" does not exist`);
    }
    for (const slot of sk.attachments ?? []) {
      if (!slots.has(slot.slot)) bad(`${where}/${slot.slot}`, "not a slot");
      for (const { key, attachment: a } of slot.entries) {
        const w = `${where}/${slot.slot}/${key}`;
        const type = attachmentType(a);
        if (!(ATTACHMENT_TYPES as readonly string[]).includes(type)) { bad(w, `unknown attachment type "${a.type}"`); continue; }
        if (a.source !== undefined) {
          const src = skinAtt(a.skin ?? "default", a.slot ?? slot.slot, a.source);
          if (!src) bad(w, `linked mesh: source "${a.source}" not found`);
          else if (src.source !== undefined || !["mesh", "linkedmesh"].includes(attachmentType(src))) bad(w, `linked mesh: source "${a.source}" is not a mesh`);
        } else if (type === "mesh" || type === "linkedmesh") {
          for (const k of ["uvs", "vertices", "triangles"] as const) if (a[k] === undefined) bad(w, `mesh without ${k}`);
        }
        if (type === "path" && a.lengths === undefined) bad(w, "path without lengths");
        if (type === "clipping" && a.end !== undefined && !slots.has(a.end)) bad(w, `clipping end "${a.end}" is not a slot`);
      }
    }
  }

  const events = new Set((s.events ?? []).map((e) => e.name));
  for (const an of s.animations ?? []) {
    const w = `animations/${an.name}`;
    for (const g of an.slots ?? []) {
      if (!slots.has(g.name)) bad(`${w}/slots`, `"${g.name}" is not a slot`);
      for (const t of g.timelines) if (!SLOT_TIMELINES.has(t.name)) bad(`${w}/slots/${g.name}`, `unknown timeline "${t.name}"`);
    }
    for (const g of an.bones ?? []) {
      boneRef(`${w}/bones`, g.name, "keyed");
      for (const t of g.timelines) if (!BONE_TIMELINES.has(t.name)) bad(`${w}/bones/${g.name}`, `unknown timeline "${t.name}"`);
    }
    for (const l of an.ik ?? []) if (!byKind.get("ik")?.has(l.name)) bad(`${w}/ik`, `"${l.name}" is not an IK constraint`);
    for (const l of an.transform ?? []) if (!byKind.get("transform")?.has(l.name)) bad(`${w}/transform`, `"${l.name}" is not a transform constraint`);
    const groupCheck = (kind: "path" | "physics" | "slider", names: ReadonlySet<string>) => {
      for (const g of an[kind] ?? []) {
        if (!(kind === "physics" && g.name === "") && !byKind.get(kind)?.has(g.name)) bad(`${w}/${kind}`, `"${g.name}" is not a ${kind} constraint`);
        for (const t of g.timelines) if (!names.has(t.name)) bad(`${w}/${kind}/${g.name}`, `unknown timeline "${t.name}"`);
      }
    };
    groupCheck("path", PATH_TIMELINES);
    groupCheck("physics", PHYSICS_TIMELINES);
    groupCheck("slider", SLIDER_TIMELINES);
    for (const st of an.attachments ?? []) {
      for (const sl of st.slots) {
        for (const g of sl.attachments) {
          const where = `${w}/attachments/${st.skin}/${sl.slot}/${g.name}`;
          if (!s.skins?.some((k) => k.name === st.skin)) bad(where, `skin "${st.skin}" does not exist`);
          else if (!skinAtt(st.skin, sl.slot, g.name)) bad(where, "attachment not found");
          for (const t of g.timelines) if (t.name !== "deform" && t.name !== "sequence") bad(where, `unknown timeline "${t.name}"`);
        }
      }
    }
    for (const k of an.events ?? []) if (typeof k.name === "string" && !events.has(k.name)) bad(`${w}/events`, `event "${k.name}" does not exist`);
    for (const k of an.drawOrder ?? []) for (const o of k.offsets ?? []) if (o.slot !== undefined && !slots.has(o.slot)) bad(`${w}/drawOrder`, `"${o.slot}" is not a slot`);
  }
  return out;
}

function constraintRefs(
  c: Constraint, where: string, boneRef: (w: string, n: string | undefined, what: string) => void,
  slots: ReadonlySet<string>, bad: (w: string, m: string) => void,
): void {
  const w = `${where} "${c.name}"`;
  switch (c.type) {
    case "ik": for (const b of c.bones ?? []) boneRef(w, b, "bone"); boneRef(w, c.target, "target"); break;
    case "transform":
      for (const b of c.bones ?? []) boneRef(w, b, "bone");
      boneRef(w, c.source, "source");
      for (const p of c.properties ?? []) {
        if (!TRANSFORM_PROPERTIES.has(p.from)) bad(w, `unknown property "${p.from}"`);
        for (const t of p.to ?? []) if (!TRANSFORM_PROPERTIES.has(t.to)) bad(w, `unknown property "${t.to}"`);
      }
      break;
    case "path": for (const b of c.bones ?? []) boneRef(w, b, "bone"); if (c.slot !== undefined && !slots.has(c.slot)) bad(w, `slot "${c.slot}" does not exist`); break;
    case "physics": boneRef(w, c.bone, "bone"); break;
    case "slider": boneRef(w, c.bone, "bone"); break;
  }
}

const SLOT_TIMELINES = new Set(["attachment", "rgba", "rgb", "alpha", "rgba2", "rgb2"]);
const BONE_TIMELINES = new Set(["rotate", "translate", "translatex", "translatey", "scale", "scalex", "scaley", "shear", "shearx", "sheary", "inherit"]);
const PATH_TIMELINES = new Set(["position", "spacing", "mix"]);
const PHYSICS_TIMELINES = new Set(["reset", "inertia", "strength", "damping", "mass", "wind", "gravity", "mix"]);
const SLIDER_TIMELINES = new Set(["time", "mix"]);
const TRANSFORM_PROPERTIES = new Set(["rotate", "x", "y", "scaleX", "scaleY", "shearY"]);
