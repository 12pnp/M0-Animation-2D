import { isArray, isObject, type Json, type JsonObject } from "@/model/json";
import type { Issue } from "@/model/issue";
import type {
  Animation, Attachment, Bone, Constraint, Curve, DrawOrderFolder, DrawOrderOffset, EventDef, Header, Key, KeyList,
  Sequence, Skeleton, Skin, SkinSlot, SkinTimelines, Slot, TimelineGroup, TransformConstraint, TransformFrom, TransformTo,
} from "@/model/skeleton";
import { CONSTRAINT_TYPES } from "@/model/skeleton";
import { type Fields, readFields } from "./fields";
import { parseJson } from "./json";
import * as F from "./skeletonFields";

/**
 * A Spine 4.3 skeleton JSON as the model (SPEC §5). Nothing is dropped: a section whose shape the
 * model cannot hold (a bone without a name, a timeline that is not a list) is kept whole in the
 * nearest `extra`, with an issue, and written back as it came.
 */
export function readSkeleton(text: string): { skeleton: Skeleton; issues: Issue[] } {
  const root = parseJson(text);
  if (!isObject(root)) throw new Error("A Spine skeleton is a JSON object.");
  return skeletonFromJson(root);
}

export function skeletonFromJson(root: JsonObject): { skeleton: Skeleton; issues: Issue[] } {
  const issues: Issue[] = [];
  const extra = new Map<string, Json>();
  const out: { -readonly [K in keyof Skeleton]: Skeleton[K] } = { extra };
  const keep = (k: string, v: Json, why: string) => { issues.push({ where: k, message: `${why}; kept as written` }); extra.set(k, v); };

  for (const [k, v] of root) {
    switch (k) {
      case "skeleton":
        if (isObject(v)) out.header = record<Header>(v, F.HEADER, "skeleton", issues);
        else keep(k, v, "the header is not an object");
        break;
      case "bones": {
        const r = list(v, (o, w) => named<Bone>(o, F.BONE, w, issues, ["name"]), "bones");
        if (r) out.bones = r; else keep(k, v, "bones that are not all named objects");
        break;
      }
      case "slots": {
        const r = list(v, (o, w) => named<Slot>(o, F.SLOT, w, issues, ["name", "bone"]), "slots");
        if (r) out.slots = r; else keep(k, v, "slots that are not all objects with a name and a bone");
        break;
      }
      case "constraints": {
        const r = list(v, (o, w) => constraint(o, w, issues), "constraints");
        if (r) out.constraints = r; else keep(k, v, "constraints the model cannot hold (unknown type, or no name)");
        break;
      }
      case "skins": {
        const r = list(v, (o, w) => skin(o, w, issues), "skins");
        if (r) out.skins = r; else keep(k, v, "skins the model cannot hold");
        break;
      }
      case "events": {
        const r = entries(v, (name, o, w) => isObject(o) ? { ...record<Omit<EventDef, "name">>(o, F.EVENT, w, issues), name } : null, "events");
        if (r) out.events = r; else keep(k, v, "events that are not objects");
        break;
      }
      case "animations": {
        const r = entries(v, (name, o, w) => isObject(o) ? animation(name, o, w, issues) : null, "animations");
        if (r) out.animations = r; else keep(k, v, "animations the model cannot hold");
        break;
      }
      default:
        extra.set(k, v);
    }
  }
  return { skeleton: out, issues };
}

/* ── helpers ── */

function record<T>(o: JsonObject, fields: Fields, where: string, issues: Issue[], nested: readonly string[] = []): T {
  const { known, extra } = readFields(o, fields, where, issues, nested);
  return { ...known, extra } as T;
}

/** A record whose `required` string keys must be there, or null. */
function named<T>(o: JsonObject, fields: Fields, where: string, issues: Issue[], required: readonly string[]): T | null {
  if (!required.every((k) => typeof o.get(k) === "string")) return null;
  return record<T>(o, fields, where, issues);
}

/** Each element of an array of objects through `one`; null when any cannot be held. */
function list<T>(v: Json, one: (o: JsonObject, where: string) => T | null, where: string): T[] | null {
  if (!isArray(v)) return null;
  const out: T[] = [];
  for (const [i, e] of v.entries()) {
    const r = isObject(e) ? one(e, `${where}[${i}]`) : null;
    if (r === null) return null;
    out.push(r);
  }
  return out;
}

/** Each entry of a name → value object through `one`, in document order; null when any cannot be held. */
function entries<T>(v: Json, one: (name: string, value: Json, where: string) => T | null, where: string): T[] | null {
  if (!isObject(v)) return null;
  const out: T[] = [];
  for (const [name, e] of v) {
    const r = one(name, e, `${where}/${name}`);
    if (r === null) return null;
    out.push(r);
  }
  return out;
}

function constraint(o: JsonObject, where: string, issues: Issue[]): Constraint | null {
  const type = o.get("type");
  if (typeof type !== "string" || typeof o.get("name") !== "string") return null;
  if (!(CONSTRAINT_TYPES as readonly string[]).includes(type)) return null;
  if (type !== "transform") return record<Constraint>(o, F.CONSTRAINT[type]!, where, issues);
  const c = record<TransformConstraint>(o, F.CONSTRAINT.transform!, where, issues, ["properties"]);
  const props = o.get("properties");
  if (props === undefined) return c;
  const read = entries(props, (from, f, w) => {
    if (!isObject(f)) return null;
    const base = record<Omit<TransformFrom, "from" | "to">>(f, F.TRANSFORM_FROM, w, issues, ["to"]);
    const to = f.get("to");
    if (to === undefined) return { ...base, from };
    const tos = entries(to, (name, t, w2) => isObject(t) ? { ...record<Omit<TransformTo, "to">>(t, F.TRANSFORM_TO, w2, issues), to: name } : null, `${w}/to`);
    return tos ? { ...base, from, to: tos } : null;
  }, `${where}/properties`);
  if (read) return { ...c, properties: read };
  issues.push({ where: `${where}/properties`, message: "a property map the model cannot hold; kept as written" });
  return { ...c, extra: new Map([...c.extra, ["properties", props]]) };
}

function skin(o: JsonObject, where: string, issues: Issue[]): Skin | null {
  if (typeof o.get("name") !== "string") return null;
  const s = record<Skin>(o, F.SKIN, where, issues, ["attachments"]);
  const atts = o.get("attachments");
  if (atts === undefined) return s;
  const read = entries(atts, (slot, slotMap, w): SkinSlot | null => {
    const es = entries(slotMap, (key, a, w2) => isObject(a) ? { key, attachment: attachment(a, w2, issues) } : null, w);
    return es ? { slot, entries: es } : null;
  }, `${where}/attachments`);
  if (read) return { ...s, attachments: read };
  issues.push({ where: `${where}/attachments`, message: "attachments the model cannot hold; kept as written" });
  return { ...s, extra: new Map([...s.extra, ["attachments", atts]]) };
}

function attachment(o: JsonObject, where: string, issues: Issue[]): Attachment {
  const a = record<Attachment>(o, F.ATTACHMENT, where, issues, ["sequence"]);
  const seq = o.get("sequence");
  if (seq === undefined) return a;
  if (isObject(seq)) return { ...a, sequence: record<Sequence>(seq, F.SEQUENCE, `${where}/sequence`, issues) };
  issues.push({ where: `${where}/sequence`, message: "a sequence that is not an object; kept as written" });
  return { ...a, extra: new Map([...a.extra, ["sequence", seq]]) };
}

function key(o: JsonObject, where: string, issues: Issue[]): Key {
  const k = record<Key>(o, F.KEY, where, issues, ["curve", "offsets"]);
  const extra = new Map(k.extra);
  let curve: Curve | undefined;
  const c = o.get("curve");
  if (typeof c === "string" || (isArray(c) && c.every((n) => typeof n === "number"))) curve = c as Curve;
  else if (c !== undefined) { issues.push({ where, message: "a curve that is neither a string nor numbers; kept as written" }); extra.set("curve", c); }
  let offsets: DrawOrderOffset[] | undefined;
  const off = o.get("offsets");
  if (off !== undefined) {
    const r = list(off, (e, w) => record<DrawOrderOffset>(e, F.DRAW_ORDER_OFFSET, w, issues), `${where}/offsets`);
    if (r) offsets = r;
    else { issues.push({ where, message: "draw order offsets that are not objects; kept as written" }); extra.set("offsets", off); }
  }
  return { ...k, ...(curve !== undefined ? { curve } : {}), ...(offsets ? { offsets } : {}), extra };
}

function keys(v: Json, where: string, issues: Issue[]): Key[] | null {
  return list(v, (o, w) => key(o, w, issues), where);
}

function keyLists(v: Json, where: string, issues: Issue[]): KeyList[] | null {
  return entries(v, (name, ks, w) => { const r = keys(ks, w, issues); return r ? { name, keys: r } : null; }, where);
}

function groups(v: Json, where: string, issues: Issue[]): TimelineGroup[] | null {
  return entries(v, (name, tl, w) => { const r = keyLists(tl, w, issues); return r ? { name, timelines: r } : null; }, where);
}

function animation(name: string, o: JsonObject, where: string, issues: Issue[]): Animation {
  const extra = new Map<string, Json>();
  const out: { -readonly [K in keyof Animation]: Animation[K] } = { name, extra };
  for (const [k, v] of o) {
    const w = `${where}/${k}`;
    let ok = true;
    switch (k) {
      case "slots": case "bones": case "path": case "physics": case "slider": {
        const r = groups(v, w, issues);
        if (r) out[k] = r; else ok = false;
        break;
      }
      case "ik": case "transform": {
        const r = keyLists(v, w, issues);
        if (r) out[k] = r; else ok = false;
        break;
      }
      case "attachments": {
        const r = entries(v, (skinName, slots, w2): SkinTimelines | null => {
          const ss = entries(slots, (slot, atts, w3) => { const g = groups(atts, w3, issues); return g ? { slot, attachments: g } : null; }, w2);
          return ss ? { skin: skinName, slots: ss } : null;
        }, w);
        if (r) out.attachments = r; else ok = false;
        break;
      }
      case "drawOrder": case "events": {
        const r = keys(v, w, issues);
        if (r) out[k] = r; else ok = false;
        break;
      }
      case "drawOrderFolder": {
        const r = list(v, (f, w2): DrawOrderFolder | null => {
          const folder = record<DrawOrderFolder>(f, F.DRAW_ORDER_FOLDER, w2, issues, ["keys"]);
          const ks = f.get("keys");
          if (ks === undefined) return folder;
          const r2 = keys(ks, `${w2}/keys`, issues);
          return r2 ? { ...folder, keys: r2 } : null;
        }, w);
        if (r) out.drawOrderFolder = r; else ok = false;
        break;
      }
      default:
        extra.set(k, v);
        continue;
    }
    if (!ok) {
      issues.push({ where: w, message: "a section the model cannot hold; kept as written" });
      extra.set(k, v);
    }
  }
  return out;
}
