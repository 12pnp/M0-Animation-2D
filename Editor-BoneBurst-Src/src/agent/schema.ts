/**
 * Arguments checked against a tool's JSON Schema before the tool runs (E5-PLAN step 2): the
 * editor takes whatever a model sends, so nothing reaches a tool that its schema does not allow.
 * The keywords the contract uses, no more: type, properties, required, additionalProperties,
 * items, minItems, maxItems, minimum, maximum, exclusiveMinimum, enum, oneOf.
 */

type Schema = Record<string, unknown>;

const typeOf = (v: unknown): string =>
  v === null ? "null" : Array.isArray(v) ? "array" : typeof v === "number" ? (Number.isInteger(v) ? "integer" : "number") : typeof v;

const fits = (v: unknown, t: string) => typeOf(v) === t || (t === "number" && typeOf(v) === "integer");

const show = (v: unknown) => JSON.stringify(v)?.slice(0, 60) ?? String(v);

/** The first way `value` breaks `schema`, said for the model to fix (`at` names where), or null. */
export function schemaProblem(value: unknown, schema: Schema, at = "arguments"): string | null {
  const t = schema.type;
  if (t !== undefined) {
    const types = Array.isArray(t) ? (t as string[]) : [t as string];
    if (!types.some((x) => fits(value, x))) return `${at} must be ${types.join(" or ")}, not ${typeOf(value)}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return `${at} must be one of ${schema.enum.map(show).join(", ")}, not ${show(value)}`;
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${at} must be at least ${schema.minimum}`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${at} must be at most ${schema.maximum}`;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return `${at} must be above ${schema.exclusiveMinimum}`;
    if (!Number.isFinite(value)) return `${at} must be a finite number`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${at} needs at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${at} takes at most ${schema.maxItems} items`;
    if (schema.items && typeof schema.items === "object") {
      for (let i = 0; i < value.length; i++) {
        const p = schemaProblem(value[i], schema.items as Schema, `${at}[${i}]`);
        if (p) return p;
      }
    }
  }
  if (typeOf(value) === "object") {
    const o = value as Record<string, unknown>, props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const k of (schema.required ?? []) as string[]) if (o[k] === undefined) return `${at}.${k} is required`;
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined) continue;
      const own = props[k];
      if (own) {
        const p = schemaProblem(v, own, `${at}.${k}`);
        if (p) return p;
      } else if (schema.additionalProperties === false) {
        const known = Object.keys(props);
        return `${at}.${k} is not an argument here${known.length ? ` (it takes ${known.join(", ")})` : ""}`;
      } else if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        const p = schemaProblem(v, schema.additionalProperties as Schema, `${at}.${k}`);
        if (p) return p;
      }
    }
  }
  if (Array.isArray(schema.oneOf)) {
    const problems = (schema.oneOf as Schema[]).map((s) => schemaProblem(value, s, at));
    const passing = problems.filter((p) => p === null).length;
    if (passing !== 1) return passing === 0 ? problems.join("; or ") : `${at} matches more than one form`;
  }
  return null;
}
