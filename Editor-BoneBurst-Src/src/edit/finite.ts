import { EditRefused } from "./history";

/**
 * Refuse numbers Spine's JSON cannot hold (E7-PLAN step 4): NaN or ±Infinity anywhere in `values`
 * (a value, an array, a plain object; maps are an attachment's extra fields and are left alone).
 * Let through, they made a document that could not be saved.
 */
export function refuseNonFinite(what: string, values: unknown): void {
  const bad = find(values, "");
  if (bad) throw new EditRefused(`${what}: ${bad.at || "the value"} must be a number, not ${bad.value}.`);
}

function find(v: unknown, at: string): { at: string; value: number } | null {
  if (typeof v === "number") return Number.isFinite(v) ? null : { at, value: v };
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) { const b = find(v[i], at ? `${at}[${i}]` : `item ${i}`); if (b) return b; }
    return null;
  }
  if (v && typeof v === "object" && !(v instanceof Map)) {
    for (const [k, x] of Object.entries(v)) { const b = find(x, at ? `${at}.${k}` : k); if (b) return b; }
  }
  return null;
}
