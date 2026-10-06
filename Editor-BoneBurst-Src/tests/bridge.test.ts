import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import contract from "@/agent/tools.json";

/**
 * The AI bridge (E5-PLAN step 2), run as the child process an MCP client starts: MCP on its
 * stdio, the editor's long poll on its HTTP side. A fake page answers calls; a fake model
 * provider stands in for Ask AI's.
 */

const PORT = 52000 + Math.floor(Math.random() * 5000);
const BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = "http://localhost:5185";
let bridge: ChildProcessWithoutNullStreams;
let provider: http.Server;
let home: string;
const seen: unknown[] = [];

/** What the fake provider answers: a tool call first, then words. */
function fakeProvider(): Promise<number> {
  provider = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    seen.push(body);
    const last = body.messages.at(-1);
    const answered = Array.isArray(last.content) && last.content.some((b: { type: string }) => b.type === "tool_result");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(answered
      ? { content: [{ type: "text", text: "Done: the rig has bones." }], stop_reason: "end_turn" }
      : { content: [{ type: "tool_use", id: "t1", name: "get_rig", input: {} }], stop_reason: "tool_use" }));
  });
  return new Promise((done) => provider.listen(0, "127.0.0.1", () => done((provider.address() as { port: number }).port)));
}

let nextId = 1;
const waiting = new Map<number, (msg: Record<string, unknown>) => void>();

/** One MCP request over the bridge's stdin; its reply from stdout. */
function mcp(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const id = nextId++;
  return new Promise((done) => {
    waiting.set(id, done);
    bridge.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`);
  });
}

/** The fake page: take the next call off the long poll, answer it with `reply`. */
async function page(reply: (call: { id: string; name: string; args: unknown }) => Record<string, unknown>): Promise<{ id: string; name: string; args: unknown }> {
  for (;;) {
    const res = await fetch(`${BASE}/agent/next`, { headers: { origin: ORIGIN } });
    if (res.status === 204) continue;
    const call = await res.json() as { id: string; name: string; args: unknown };
    await fetch(`${BASE}/agent/result`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ id: call.id, ...reply(call) }) });
    return call;
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "bridge-test-"));
  const providerPort = await fakeProvider();
  bridge = spawn(process.execPath, [join(__dirname, "..", "mcp", "bridge.mjs")], {
    env: {
      PATH: process.env.PATH ?? "", HOME: home,
      BONEBURST_BRIDGE_PORT: String(PORT), BONEBURST_CALL_TIMEOUT: "400",
      BONEBURST_KEYFILE: join(home, "keys.json"), BONEBURST_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "test-key", BONEBURST_API_URL: `http://127.0.0.1:${providerPort}/v1/messages`,
    },
  });
  let buffer = "";
  bridge.stdout.setEncoding("utf8");
  bridge.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
  });
  // Listening once the status answers.
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(`${BASE}/agent/status`)).ok) break; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 50));
  }
});

afterAll(() => {
  bridge?.kill();
  provider?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("the AI bridge (E5 step 2)", () => {
  it("introduces itself with the contract's version and what changed from version 1", async () => {
    const r = (await mcp("initialize", { protocolVersion: "2025-06-18" })).result as { instructions: string; serverInfo: { name: string } };
    expect(r.serverInfo.name).toBe("boneburst-editor");
    expect(r.instructions).toContain("Tool contract version 2 (from 1");
    expect(r.instructions).toContain("- set_cycle: dropped.");
    expect(r.instructions).toContain("- auto_rig: same arguments, new meaning: `layers` names slots");
  });
  it("lists every contract tool with its schema", async () => {
    const r = (await mcp("tools/list")).result as { tools: { name: string; inputSchema: unknown }[] };
    expect(r.tools.map((t) => t.name)).toEqual(contract.tools.map((t) => t.name));
    expect(r.tools.find((t) => t.name === "set_keys")!.inputSchema).toEqual(contract.tools.find((t) => t.name === "set_keys")!.input_schema);
  });
  it("takes a call to the editor and its answer back; a refusal comes back as an error the model reads", async () => {
    const [reply, call] = await Promise.all([mcp("tools/call", { name: "get_pose", arguments: { frame: 3 } }), page(() => ({ ok: true, value: { bones: { root: [0, 0] } } }))]);
    expect(call).toMatchObject({ name: "get_pose", args: { frame: 3 } });
    const content = (reply.result as { content: { type: string; text: string }[] }).content;
    expect(JSON.parse(content[0]!.text)).toEqual({ bones: { root: [0, 0] } });
    const [refused] = await Promise.all([mcp("tools/call", { name: "show", arguments: { animation: "nope" } }), page(() => ({ ok: false, error: 'There is no animation "nope".' }))]);
    expect(refused.result).toEqual({ content: [{ type: "text", text: 'There is no animation "nope".' }], isError: true });
  });
  it("refuses an unknown tool and a call nobody answers, saying why", async () => {
    expect((await mcp("tools/call", { name: "set_cycle", arguments: {} })).error).toMatchObject({ code: -32602, message: "Unknown tool: set_cycle" });
    // No page polling: the editor is not connected (seen long ago, so it says how to connect).
    const lone = (await mcp("tools/call", { name: "get_rig", arguments: {} })).result as { content: { text: string }[]; isError: boolean };
    expect(lone.isError).toBe(true);
    expect(lone.content[0]!.text).toMatch(/did not answer "get_rig" in time|press the AI button/);
  });
  it("only the editor's origins may use its HTTP side", async () => {
    const status = await new Promise<number>((done) => {
      http.get(`${BASE}/agent/status`, { headers: { origin: "http://example.com" } }, (res) => { res.resume(); done(res.statusCode!); });
    });
    expect(status).toBe(403);
    expect((await fetch(`${BASE}/agent/status`, { headers: { origin: ORIGIN } })).status).toBe(200);
  });
  it("Ask AI: the model's tool call runs in the editor, and its last words come back", async () => {
    const chat = fetch(`${BASE}/chat`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ messages: [{ role: "user", content: "What bones are there?" }] }) });
    const call = await page(() => ({ ok: true, value: { bones: ["root", "hips"] } }));
    expect(call.name).toBe("get_rig");
    const out = await (await chat).json() as { text: string };
    expect(out.text).toBe("Done: the rig has bones.");
    const first = seen[0] as { tools: { name: string }[]; system: string };
    expect(first.tools).toHaveLength(contract.tools.length);
    expect(first.system).toContain("BoneBurst Editor");
  });
});
