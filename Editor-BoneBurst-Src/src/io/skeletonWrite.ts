import type { Json, JsonObject } from "@/model/json";
import type {
  Animation, Attachment, Constraint, Key, KeyList, Skeleton, Skin, TimelineGroup,
} from "@/model/skeleton";
import { type Fields, writeFields } from "./fields";
import { stringifyJson } from "./json";
import * as F from "./skeletonFields";

/**
 * Spine 4.3 JSON for a skeleton (SPEC §5): each object's known keys, then whatever the file had
 * that the model does not hold, in its order. Sections and name → value maps keep the model's
 * order, which is the file's for anything read.
 */
export function writeSkeleton(s: Skeleton, indent = "  "): string {
  return stringifyJson(skeletonToJson(s), indent);
}

export function skeletonToJson(s: Skeleton): JsonObject {
  const out: [string, Json][] = [];
  if (s.header) out.push(["skeleton", rec(s.header, F.HEADER)]);
  if (s.bones) out.push(["bones", s.bones.map((b) => rec(b, F.BONE))]);
  if (s.slots) out.push(["slots", s.slots.map((x) => rec(x, F.SLOT))]);
  if (s.constraints) out.push(["constraints", s.constraints.map(constraint)]);
  if (s.skins) out.push(["skins", s.skins.map(skin)]);
  if (s.events) out.push(["events", new Map(s.events.map((e) => [e.name, rec(e, F.EVENT)] as const))]);
  if (s.animations) out.push(["animations", new Map(s.animations.map((a) => [a.name, animation(a)] as const))]);
  return withExtra(out, s.extra);
}

function withExtra(entries: [string, Json][], extra: JsonObject): JsonObject {
  return new Map([...entries, ...extra]);
}

function rec(o: { readonly extra: JsonObject }, fields: Fields, nested: [string, Json][] = []): JsonObject {
  return withExtra([...writeFields(o, fields), ...nested], o.extra);
}

function constraint(c: Constraint): JsonObject {
  const nested: [string, Json][] = [];
  if (c.type === "transform" && c.properties) {
    nested.push(["properties", new Map(c.properties.map((p) => [p.from, rec(p, F.TRANSFORM_FROM,
      p.to ? [["to", new Map(p.to.map((t) => [t.to, rec(t, F.TRANSFORM_TO)] as const))]] : [])] as const))]);
  }
  return rec(c, F.CONSTRAINT[c.type]!, nested);
}

function skin(s: Skin): JsonObject {
  return rec(s, F.SKIN, s.attachments
    ? [["attachments", new Map(s.attachments.map((slot) => [slot.slot, new Map(slot.entries.map((e) => [e.key, attachment(e.attachment)] as const))] as const))]]
    : []);
}

function attachment(a: Attachment): JsonObject {
  return rec(a, F.ATTACHMENT, a.sequence ? [["sequence", rec(a.sequence, F.SEQUENCE)]] : []);
}

function key(k: Key): JsonObject {
  const nested: [string, Json][] = [];
  if (k.curve !== undefined) nested.push(["curve", k.curve as Json]);
  if (k.offsets) nested.push(["offsets", k.offsets.map((o) => rec(o, F.DRAW_ORDER_OFFSET))]);
  return rec(k, F.KEY, nested);
}

function keyLists(ls: readonly KeyList[]): JsonObject {
  return new Map(ls.map((l) => [l.name, l.keys.map(key)] as const));
}

function groups(gs: readonly TimelineGroup[]): JsonObject {
  return new Map(gs.map((g) => [g.name, keyLists(g.timelines)] as const));
}

function animation(a: Animation): JsonObject {
  const out: [string, Json][] = [];
  if (a.slots) out.push(["slots", groups(a.slots)]);
  if (a.bones) out.push(["bones", groups(a.bones)]);
  if (a.ik) out.push(["ik", keyLists(a.ik)]);
  if (a.transform) out.push(["transform", keyLists(a.transform)]);
  if (a.path) out.push(["path", groups(a.path)]);
  if (a.physics) out.push(["physics", groups(a.physics)]);
  if (a.slider) out.push(["slider", groups(a.slider)]);
  if (a.attachments) {
    out.push(["attachments", new Map(a.attachments.map((s) => [s.skin,
      new Map(s.slots.map((sl) => [sl.slot, groups(sl.attachments)] as const))] as const))]);
  }
  if (a.drawOrder) out.push(["drawOrder", a.drawOrder.map(key)]);
  if (a.drawOrderFolder) {
    out.push(["drawOrderFolder", a.drawOrderFolder.map((f) => rec(f, F.DRAW_ORDER_FOLDER, f.keys ? [["keys", f.keys.map(key)]] : []))]);
  }
  if (a.events) out.push(["events", a.events.map(key)]);
  return withExtra(out, a.extra);
}
