import { isArray, isObject, type Json, type JsonObject } from "@/model/json";

/** A JSON text that does not parse: where, and why. */
export class JsonSyntaxError extends Error {
  constructor(message: string, readonly offset: number) {
    super(`${message} at offset ${offset}`);
  }
}

/** How deep objects and arrays may nest: a skeleton nests under ten. */
const MAX_DEPTH = 1000;

/**
 * Parse JSON text into `Json`, objects as `Map`s in document order. A duplicate key keeps the
 * place of its first occurrence and takes the last value, as Spine's reader does
 * (Format-Json-Atlas.md §2). Strict otherwise: what the Spine Editor and this editor write.
 */
export function parseJson(text: string): Json {
  let i = 0;
  const fail = (what: string): never => { throw new JsonSyntaxError(what, i); };
  const ws = () => {
    for (;;) {
      const c = text.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else if (c === 0xfeff && i === 0) i++;
      else return;
    }
  };
  const string = (): string => {
    i++; // opening quote
    let out = "";
    let run = i;
    for (;;) {
      const c = text.charCodeAt(i);
      if (Number.isNaN(c)) fail("unterminated string");
      if (c === 34) { out += text.slice(run, i); i++; return out; }
      if (c === 92) {
        out += text.slice(run, i);
        const e = text[i + 1];
        switch (e) {
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          case "/": out += "/"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "n": out += "\n"; break;
          case "r": out += "\r"; break;
          case "t": out += "\t"; break;
          case "u": {
            const hex = text.slice(i + 2, i + 6);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail("bad \\u escape");
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default: fail("bad escape");
        }
        i += 2;
        run = i;
        continue;
      }
      if (c < 32) fail("control character in string");
      i++;
    }
  };
  const number = (): number => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(text.slice(i, i + 64));
    if (!m) fail("bad number");
    i += m![0].length;
    const n = Number(m![0]);
    // 1e400 parses as Infinity, which no file can hold: the document would open and never save
    // (E7-PLAN step 5).
    if (!Number.isFinite(n)) fail(`number ${m![0]} out of range`);
    return n;
  };
  // Deeper than any skeleton nests, and well short of the stack (E7-PLAN step 5).
  let depth = 0;
  const value = (): Json => {
    ws();
    const c = text[i];
    if ((c === "{" || c === "[") && ++depth > MAX_DEPTH) fail(`nested deeper than ${MAX_DEPTH}`);
    if (c === "{") {
      i++;
      const map = new Map<string, Json>();
      ws();
      if (text[i] === "}") { i++; depth--; return map; }
      for (;;) {
        ws();
        if (text[i] !== '"') fail("expected a key");
        const key = string();
        ws();
        if (text[i] !== ":") fail("expected ':'");
        i++;
        map.set(key, value());
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; depth--; return map; }
        fail("expected ',' or '}'");
      }
    }
    if (c === "[") {
      i++;
      const arr: Json[] = [];
      ws();
      if (text[i] === "]") { i++; depth--; return arr; }
      for (;;) {
        arr.push(value());
        ws();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; depth--; return arr; }
        fail("expected ',' or ']'");
      }
    }
    if (c === '"') return string();
    if (c === "-" || (c !== undefined && c >= "0" && c <= "9")) return number();
    if (text.startsWith("true", i)) { i += 4; return true; }
    if (text.startsWith("false", i)) { i += 5; return false; }
    if (text.startsWith("null", i)) { i += 4; return null; }
    return fail("unexpected character");
  };
  const out = value();
  ws();
  if (i !== text.length) fail("text after the value");
  return out;
}

/** JSON text for a value, objects in their `Map` order. `indent` "" writes one line. */
export function stringifyJson(v: Json, indent = "  "): string {
  const nl = indent ? "\n" : "";
  const sep = indent ? ": " : ":";
  const write = (x: Json, pad: string): string => {
    if (x === null) return "null";
    if (typeof x === "boolean") return x ? "true" : "false";
    if (typeof x === "number") {
      if (!Number.isFinite(x)) throw new Error(`not a JSON number: ${x}`);
      return Object.is(x, -0) ? "0" : String(x);
    }
    if (typeof x === "string") return JSON.stringify(x);
    const inner = pad + indent;
    if (isArray(x)) {
      if (x.length === 0) return "[]";
      // Arrays of plain values stay on one line: vertices, uvs, curves.
      if (x.every((e) => !isObject(e) && !isArray(e))) return `[${x.map((e) => write(e, inner)).join(indent ? ", " : ",")}]`;
      return `[${nl}${x.map((e) => inner + write(e, inner)).join(`,${nl}`)}${nl}${pad}]`;
    }
    if (x.size === 0) return "{}";
    return `{${nl}${[...x].map(([k, e]) => `${inner}${JSON.stringify(k)}${sep}${write(e, inner)}`).join(`,${nl}`)}${nl}${pad}}`;
  };
  return write(v, "");
}

/**
 * Whether two values are equal. `ordered(path)` says whether an object's key order matters at
 * that path (keys are names: animations, events, timelines); elsewhere it does not.
 * The first difference is reported through `diff`, as a path.
 */
export function jsonEqual(
  a: Json, b: Json, ordered: (path: readonly string[]) => boolean = () => true,
  diff?: (path: string) => void,
): boolean {
  const walk = (x: Json, y: Json, path: string[]): boolean => {
    const no = (why: string) => { diff?.(`${path.join("/") || "(root)"}: ${why}`); return false; };
    if (isObject(x) || isObject(y)) {
      if (!isObject(x) || !isObject(y)) return no("object vs not");
      if (x.size !== y.size) return no(`keys ${[...x.keys()].join(",")} vs ${[...y.keys()].join(",")}`);
      if (ordered(path) && [...x.keys()].join("\u0000") !== [...y.keys()].join("\u0000")) return no("key order");
      for (const [k, v] of x) {
        if (!y.has(k)) return no(`missing ${k}`);
        if (!walk(v, y.get(k)!, [...path, k])) return false;
      }
      return true;
    }
    if (isArray(x) || isArray(y)) {
      if (!isArray(x) || !isArray(y)) return no("array vs not");
      if (x.length !== y.length) return no(`length ${x.length} vs ${y.length}`);
      return x.every((v, n) => walk(v, y[n]!, [...path, String(n)]));
    }
    return Object.is(x, y) || (x === 0 && y === 0) ? true : no(`${String(x)} vs ${String(y)}`);
  };
  return walk(a, b, []);
}

/** A `Map` from entries, typed as a JSON object. */
export function obj(entries: Iterable<readonly [string, Json]>): JsonObject {
  return new Map(entries);
}

/**
 * The value as `JSON.parse` would give it: objects as plain objects. What the engine reads
 * (SPEC §6). Integer-like keys take `JSON.parse`'s order here, which is the order Spine's own
 * web runtime sees too.
 */
export function plainJson(v: Json): unknown {
  if (v === null || typeof v !== "object") return v;
  if (Array.isArray(v)) return v.map(plainJson);
  const out: Record<string, unknown> = {};
  for (const [k, e] of v as JsonObject) out[k] = plainJson(e);
  return out;
}
