import { isArray, type Json, type JsonObject } from "@/model/json";
import type { Issue } from "@/model/issue";

/** The JSON type a known key must have; anything else stays in `extra` with an issue. */
export type Kind = "num" | "str" | "bool" | "nums" | "strs" | "strOrNull";

/** An object kind's plain keys and their types. Nested keys are read by the caller. */
export type Fields = readonly (readonly [key: string, kind: Kind])[];

function fits(kind: Kind, v: Json): boolean {
  switch (kind) {
    case "num": return typeof v === "number";
    case "str": return typeof v === "string";
    case "bool": return typeof v === "boolean";
    case "strOrNull": return v === null || typeof v === "string";
    case "nums": return isArray(v) && v.every((e) => typeof e === "number");
    case "strs": return isArray(v) && v.every((e) => typeof e === "string");
  }
}

/**
 * The plain known keys of `o` as fields, and every other key, except those in `nested`, as
 * `extra` in file order. A known key with the wrong type goes to `extra`, with an issue at `where`.
 */
export function readFields(
  o: JsonObject, fields: Fields, where: string, issues: Issue[], nested: readonly string[] = [],
): { known: Record<string, Json>; extra: Map<string, Json> } {
  const kinds = new Map(fields);
  const known: Record<string, Json> = {};
  const extra = new Map<string, Json>();
  for (const [k, v] of o) {
    if (nested.includes(k)) continue;
    const kind = kinds.get(k);
    if (kind && fits(kind, v)) known[k] = v;
    else {
      if (kind) issues.push({ where, message: `"${k}" should be ${kindName(kind)}; kept as written` });
      extra.set(k, v);
    }
  }
  return { known, extra };
}

function kindName(k: Kind): string {
  return { num: "a number", str: "a string", bool: "true or false", strOrNull: "a string or null", nums: "a list of numbers", strs: "a list of strings" }[k];
}

/** `o`'s set fields in table order, as JSON entries. */
export function writeFields(o: object, fields: Fields): [string, Json][] {
  const out: [string, Json][] = [];
  for (const [k] of fields) {
    const v = (o as Record<string, unknown>)[k];
    if (v !== undefined) out.push([k, v as Json]);
  }
  return out;
}
