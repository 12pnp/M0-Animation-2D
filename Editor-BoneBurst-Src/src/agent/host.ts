import type { History } from "@/edit/history";
import type { Skeleton } from "@/model/skeleton";
import { type AgentContext, AgentRefused } from "./context";
import type { Contract, Tool } from "./contract";
import { BUILD_TOOLS } from "./build";
import { CHECK_TOOLS } from "./check";
import { KEY_TOOLS } from "./keys";
import { LOOK_TOOLS } from "./looks";
import { MESH_TOOLS } from "./meshes";
import { MOTION_TOOLS } from "./motion";
import { READ_TOOLS } from "./read";
import { schemaProblem } from "./schema";
import { SEQUENCE_TOOLS } from "./sequences";
import { UNITY_TOOLS } from "./unity";
import contract from "./tools.json";

/**
 * Where an AI's tool calls land (E5-PLAN step 2): the contract's tool by name, its arguments
 * checked against its schema, then the tool itself. Pure: the editor gives a context
 * (`./context.ts`). A refusal is an `AgentRefused`, whose message the model reads and can act
 * on; anything else that throws is the editor's fault and says so.
 */

export * from "./context";

type ToolFn = (args: Record<string, unknown>, ctx: AgentContext) => unknown | Promise<unknown>;

export const CONTRACT = contract as unknown as Contract;
const BY_NAME = new Map<string, Tool>(CONTRACT.tools.map((t) => [t.name, t]));

function open(ctx: AgentContext): History<Skeleton> {
  if (!ctx.history) throw new AgentRefused("Nothing is open in the editor: open a skeleton (or drop a PSD) first.");
  return ctx.history;
}

/** Undo or redo up to `steps` steps; what was undone or redone, newest first. */
function step(dir: "undo" | "redo"): ToolFn {
  return (args, ctx) => {
    const h = open(ctx), want = (args.steps as number | undefined) ?? 1, done: string[] = [];
    for (let i = 0; i < want; i++) {
      const label = dir === "undo" ? h.undoLabel : h.redoLabel;
      if (label === undefined || !(dir === "undo" ? h.undo() : h.redo())) break;
      done.push(label);
    }
    if (done.length) ctx.changed();
    return { [dir === "undo" ? "undone" : "redone"]: done, ...(done.length < want ? { note: `only ${done.length} step${done.length === 1 ? "" : "s"} to ${dir}` } : {}) };
  };
}

/** Every tool of the contract (a test holds the two lists equal). */
const TOOLS: Record<string, ToolFn> = {
  undo: step("undo"),
  redo: step("redo"),
  ...READ_TOOLS,
  ...KEY_TOOLS,
  ...BUILD_TOOLS,
  ...MOTION_TOOLS,
  ...CHECK_TOOLS,
  ...LOOK_TOOLS,
  ...SEQUENCE_TOOLS,
  ...MESH_TOOLS,
  ...UNITY_TOOLS,
};

/** Run the tool `name` with `args` on the editor's document. */
export async function callTool(name: string, args: unknown, ctx: AgentContext): Promise<unknown> {
  const tool = BY_NAME.get(name);
  if (!tool) throw new AgentRefused(`There is no tool "${name}" in contract version ${CONTRACT.version.number}.`);
  const given = args ?? {};
  const problem = schemaProblem(given, tool.input_schema as Record<string, unknown>);
  if (problem) throw new AgentRefused(`${name}: ${problem}.`);
  const fn = TOOLS[name];
  if (!fn) throw new AgentRefused(`${name} is in the contract but not built in this editor yet.`);
  return fn(given as Record<string, unknown>, ctx);
}

/** The tools the editor answers now. */
export const builtTools = (): string[] => Object.keys(TOOLS);
