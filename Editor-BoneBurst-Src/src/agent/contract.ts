/**
 * The AI tool contract (E5-PLAN step 1; D5): `tools.json` names each tool with its JSON Schema,
 * and its `version` block lists every change from the contract before it. Pure: the gate that
 * keeps the note honest is a function, tested, and run on the real contract by `npm run check`.
 */

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly input_schema: unknown;
}

export type Change =
  | { readonly tool: string; readonly change: "dropped"; readonly why: string; readonly instead: string }
  | { readonly tool: string; readonly change: "renamed"; readonly to: string; readonly why: string }
  | { readonly tool: string; readonly change: "reshaped"; readonly what: string }
  | { readonly tool: string; readonly change: "meaning"; readonly what: string };

export interface Contract {
  readonly version: { readonly number: number; readonly from: number; readonly date: string; readonly note: string; readonly changes: readonly Change[] };
  readonly tools: readonly Tool[];
}

/** The tools the owner's flow runs on: their names and argument shapes never change (E5 done-when). */
export const FLOW_TOOLS = ["auto_rig", "apply_motion", "check_preview", "set_keys", "show", "get_pose"] as const;

/** A schema's shape: what a call may send, without the prose (`description`) around it. */
export function shape(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(shape);
  if (schema && typeof schema === "object") {
    return Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "description").sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, shape(v)]));
  }
  return schema;
}

const same = (a: unknown, b: unknown) => JSON.stringify(shape(a)) === JSON.stringify(shape(b));

/**
 * What is wrong with `next` as the version after `before`: a tool gone, renamed or reshaped with
 * no line in the note; a line for a change that did not happen; a flow tool changed at all.
 * Empty when the contract and its note agree.
 */
export function contractProblems(before: readonly Tool[], next: Contract): string[] {
  const out: string[] = [];
  const old = new Map(before.map((t) => [t.name, t])), now = new Map(next.tools.map((t) => [t.name, t]));
  if (now.size !== next.tools.length) out.push("a tool name appears twice");
  const noted = new Map<string, Change>();
  for (const c of next.version.changes) {
    if (noted.has(c.tool)) out.push(`${c.tool}: listed twice in the version note`);
    noted.set(c.tool, c);
    if (!old.has(c.tool)) { out.push(`${c.tool}: the note lists it, but version ${next.version.from} had no such tool`); continue; }
    const here = now.get(c.tool);
    switch (c.change) {
      case "dropped": if (here) out.push(`${c.tool}: listed as dropped, but it is still served`); break;
      case "renamed":
        if (here) out.push(`${c.tool}: listed as renamed to ${c.to}, but the old name is still served`);
        if (!now.has(c.to)) out.push(`${c.tool}: listed as renamed to ${c.to}, which is not served`);
        break;
      case "reshaped": if (!here) out.push(`${c.tool}: listed as reshaped, but it is not served`); else if (same(here.input_schema, old.get(c.tool)!.input_schema)) out.push(`${c.tool}: listed as reshaped, but its arguments are as they were`); break;
      case "meaning": if (!here) out.push(`${c.tool}: listed with a new meaning, but it is not served`); break;
    }
  }
  for (const [name, t] of old) {
    const here = now.get(name), c = noted.get(name);
    if (!here && !c) out.push(`${name}: gone from the contract with no line in the version note`);
    if (here && !same(here.input_schema, t.input_schema) && c?.change !== "reshaped") out.push(`${name}: its arguments changed with no "reshaped" line in the version note`);
  }
  for (const name of FLOW_TOOLS) {
    const was = old.get(name), here = now.get(name);
    if (!was) continue;
    if (!here || !same(here.input_schema, was.input_schema)) out.push(`${name}: a flow tool, it keeps version ${next.version.from}'s name and arguments`);
  }
  return out;
}
