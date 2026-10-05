/**
 * JSON values as the editor holds them: objects are `Map`s, so every key keeps its place in the
 * file, integer-like ones included (a plain object would move `"1"` to the front, and Spine reads
 * animations, events and timelines in document order).
 */
export type Json = null | boolean | number | string | JsonArray | JsonObject;
export type JsonArray = readonly Json[];
export type JsonObject = ReadonlyMap<string, Json>;

export function isObject(v: Json | undefined): v is JsonObject {
  return v instanceof Map;
}

export function isArray(v: Json | undefined): v is JsonArray {
  return Array.isArray(v);
}
