import { describe, expect, it } from "vitest";
import { updateBone } from "@/edit/bones";
import { History } from "@/edit/history";
import { newSkeleton } from "@/edit/newSkeleton";
import { AgentRefused, callTool } from "@/agent/host";
import { schemaProblem } from "@/agent/schema";
import type { Skeleton } from "@/model/skeleton";
import { testContext } from "./fixtures/agentContext";

const ctx = (history: History<Skeleton> | null) => testContext(history);
const refused = async (p: Promise<unknown>) => { try { await p; return ""; } catch (e) { expect(e).toBeInstanceOf(AgentRefused); return (e as Error).message; } };

describe("the agent host (E5 step 2)", () => {
  it("undo and redo walk the history, saying what they took back", async () => {
    const h = new History(newSkeleton("h"));
    h.apply("Move root", updateBone("root", { x: 10 }));
    h.apply("Turn root", updateBone("root", { rotation: 5 }));
    const c = ctx(h);
    expect(await callTool("undo", { steps: 5 }, c)).toEqual({ undone: ["Turn root", "Move root"], note: "only 2 steps to undo" });
    expect(h.doc.bones![0]!.x).toBeUndefined();
    expect(await callTool("redo", {}, c)).toEqual({ redone: ["Move root"] });
    expect(h.doc.bones![0]!.x).toBe(10);
    expect(c.told).toBe(2);
  });
  it("refuses what the model can fix: no document, unknown tools, arguments the schema does not allow, tools not built", async () => {
    expect(await refused(callTool("undo", {}, ctx(null)))).toMatch(/Nothing is open/);
    expect(await refused(callTool("set_cycle", {}, ctx(null)))).toBe('There is no tool "set_cycle" in contract version 2.');
    const c = ctx(new History(newSkeleton("h")));
    expect(await refused(callTool("undo", { steps: 0 }, c))).toBe("undo: arguments.steps must be at least 1.");
    expect(await refused(callTool("undo", { step: 2 }, c))).toBe("undo: arguments.step is not an argument here (it takes steps).");
    expect(await refused(callTool("set_keys", { animation: "walk", keys: [{ bone: "root", frame: 0 }] }, c))).toBe("set_keys is in the contract but not built in this editor yet.");
  });
  it("checks arguments the way the contract's schemas say", () => {
    const ease = { oneOf: [{ type: "string", enum: ["linear", "in"] }, { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 }] };
    const keys = { type: "object", properties: { keys: { type: "array", minItems: 1, items: { type: "object", properties: { bone: { type: "string" }, frame: { type: "integer", minimum: 0 }, ease }, required: ["bone"], additionalProperties: false } }, map: { type: "object", additionalProperties: { type: ["string", "null"] } } }, required: ["keys"] };
    expect(schemaProblem({ keys: [{ bone: "a", frame: 2, ease: "in" }], map: { hips: null, knee: "k" } }, keys)).toBeNull();
    expect(schemaProblem({ keys: [] }, keys)).toBe("arguments.keys needs at least 1 item");
    expect(schemaProblem({ keys: [{ bone: "a", frame: 1.5 }] }, keys)).toBe("arguments.keys[0].frame must be integer, not number");
    expect(schemaProblem({ keys: [{ frame: 1 }] }, keys)).toBe("arguments.keys[0].bone is required");
    expect(schemaProblem({ keys: [{ bone: "a", ease: [0, 1] }] }, keys)).toMatch(/must be string, not array; or arguments.keys\[0\].ease needs at least 4 items/);
    expect(schemaProblem({ keys: [{ bone: "a" }], map: { hips: 3 } }, keys)).toBe("arguments.map.hips must be string or null, not integer");
    expect(schemaProblem({ keys: [{ bone: "a", ease: "out" }] }, keys)).toMatch(/must be one of "linear", "in", not "out"/);
    expect(schemaProblem("x", keys)).toBe("arguments must be object, not string");
    expect(schemaProblem(0, { type: "number", exclusiveMinimum: 0 })).toBe("arguments must be above 0");
  });
});
