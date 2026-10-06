import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type Contract, contractProblems, FLOW_TOOLS, shape, type Tool } from "@/agent/contract";
import contract from "@/agent/tools.json";

/** v1's contract, frozen: what MCP clients written for the old editor send (E5-PLAN step 1). */
const V1: Tool[] = JSON.parse(readFileSync(join(__dirname, "fixtures", "tools-v1.json"), "utf8"));
const V2 = contract as unknown as Contract;

const tool = (name: string, props: Record<string, unknown> = {}): Tool => ({ name, description: `${name}.`, input_schema: { type: "object", properties: props } });
const version = (changes: Contract["version"]["changes"]) => ({ number: 2, from: 1, date: "d", note: "n", changes });

describe("the tool contract (E5 step 1, D5)", () => {
  it("v2 and its version note agree with v1: every drop, rename and reshape listed, the flow untouched", () => {
    expect(contractProblems(V1, V2)).toEqual([]);
    expect(V2.version).toMatchObject({ number: 2, from: 1 });
    for (const name of FLOW_TOOLS) expect(shape(V2.tools.find((t) => t.name === name)!.input_schema)).toEqual(shape(V1.find((t) => t.name === name)!.input_schema));
  });
  it("fails a tool gone, renamed or reshaped without its line, and a line for a change that did not happen", () => {
    const before = [tool("a", { x: { type: "number" } }), tool("b"), tool("c")];
    // b dropped and c renamed, unlisted; a reshaped, unlisted.
    expect(contractProblems(before, { version: version([]), tools: [tool("a", { x: { type: "string" } }), tool("c2")] })).toEqual([
      'a: its arguments changed with no "reshaped" line in the version note',
      "b: gone from the contract with no line in the version note",
      "c: gone from the contract with no line in the version note",
    ]);
    // Listed: no problem.
    expect(contractProblems(before, { version: version([
      { tool: "a", change: "reshaped", what: "x is text" },
      { tool: "b", change: "dropped", why: "w", instead: "i" },
      { tool: "c", change: "renamed", to: "c2", why: "w" },
    ]), tools: [tool("a", { x: { type: "string" } }), tool("c2")] })).toEqual([]);
    // Lines for what did not happen.
    expect(contractProblems(before, { version: version([
      { tool: "a", change: "reshaped", what: "-" },
      { tool: "b", change: "dropped", why: "w", instead: "i" },
      { tool: "z", change: "meaning", what: "-" },
    ]), tools: before })).toEqual([
      "a: listed as reshaped, but its arguments are as they were",
      "b: listed as dropped, but it is still served",
      "z: the note lists it, but version 1 had no such tool",
    ]);
  });
  it("a flow tool may change its prose, never its arguments, even with a line in the note", () => {
    const before = [tool("set_keys", { animation: { type: "string", description: "old words" } })];
    expect(contractProblems(before, { version: version([]), tools: [tool("set_keys", { animation: { type: "string", description: "new words" } })] })).toEqual([]);
    expect(contractProblems(before, { version: version([{ tool: "set_keys", change: "reshaped", what: "-" }]), tools: [tool("set_keys", { animation: { type: "integer" } })] }))
      .toEqual(["set_keys: a flow tool, it keeps version 1's name and arguments"]);
  });
});
