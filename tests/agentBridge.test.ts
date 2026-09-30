import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { Store } from "@/app/Store";
import { AGENT_TOOLS, AgentApi, AgentError } from "@/app/agent/AgentApi";
import { loadStickman } from "./fixtures/stickman";

/**
 * `mcp/amino-bridge.mjs` as Claude Code runs it: MCP over stdio on one side,
 * the editor page's long poll on the other. The "page" here is a real
 * `AgentApi` on the stickman, polling as `AgentBridge` does; the Claude API
 * for Ask AI is a fake that asks for one tool and then answers.
 */

const BRIDGE = fileURLToPath(new URL("../mcp/amino-bridge.mjs", import.meta.url));
const PORT = 5391, API_PORT = 5392;
const ORIGIN = "http://localhost:5181";

let bridge: ChildProcess;
let fakeApi: http.Server;
const apiRequests: Array<{ messages: Array<{ role: string; content: unknown }>; tools: Array<{ name: string }> }> = [];
let pageRunning = true;
let buffer = "";
const waiting = new Map<number, (msg: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
let nextId = 0;

function rpc(method: string, params: unknown): Promise<{ result?: Record<string, unknown>; error?: { message: string } }> {
  return new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    bridge.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

/** The page's side, as `AgentBridge.loop` does it. */
async function runPage(api: AgentApi): Promise<void> {
  while (pageRunning) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/agent/next`, { headers: { origin: ORIGIN } });
      if (res.status === 204) continue;
      const call = await res.json() as { id: string; name: string; args: Record<string, unknown> };
      let body: Record<string, unknown>;
      try { body = { id: call.id, ok: true, value: await api.call(call.name, call.args) }; } catch (err) {
        body = { id: call.id, ok: false, error: err instanceof AgentError ? err.message : String(err) };
      }
      await fetch(`http://127.0.0.1:${PORT}/agent/result`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

beforeAll(async () => {
  reseed();
  const { project } = await loadStickman();
  const api = new AgentApi(new Store(project));

  // A fake Messages API: first asks for get_rig, then says it is done.
  fakeApi = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    apiRequests.push(body);
    const first = apiRequests.length === 1;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(first
      ? { content: [{ type: "tool_use", id: "tu1", name: "get_rig", input: {} }], stop_reason: "tool_use" }
      : { content: [{ type: "text", text: "The rig has hips." }], stop_reason: "end_turn" }));
  });
  await new Promise<void>((r) => fakeApi.listen(API_PORT, "127.0.0.1", r));

  bridge = spawn("node", [BRIDGE], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, AMINO_BRIDGE_PORT: String(PORT), ANTHROPIC_API_KEY: "test", AMINO_API_URL: `http://127.0.0.1:${API_PORT}/v1/messages` },
  });
  bridge.stdout!.setEncoding("utf8");
  bridge.stdout!.on("data", (d: string) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      waiting.get(msg.id)?.(msg);
    }
  });
  await new Promise<void>((r) => bridge.stderr!.once("data", () => r()));
  void runPage(api);
});

afterAll(async () => {
  pageRunning = false;
  bridge?.kill();
  await new Promise((r) => fakeApi.close(r));
});

describe("the AI bridge", () => {
  it("speaks MCP: initialize, then the editor's tools", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } });
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "amino-spine2d" } });
    const list = await rpc("tools/list", {});
    const tools = list.result!.tools as Array<{ name: string; inputSchema: object }>;
    expect(tools.map((t) => t.name)).toEqual(AGENT_TOOLS.map((t) => t.name));
    for (const t of tools) expect(t.inputSchema).toBeTruthy();
  });

  it("runs a tool call in the page and returns its answer", async () => {
    const out = await rpc("tools/call", { name: "get_rig", arguments: {} });
    const content = out.result!.content as Array<{ text: string }>;
    const rig = JSON.parse(content[0]!.text);
    expect(rig.bones.map((b: { name: string }) => b.name)).toContain("hips");
    expect(out.result!.isError).toBeUndefined();
  });

  it("hands a wrong call's message back to the model as an error result", async () => {
    const out = await rpc("tools/call", { name: "set_keys", arguments: { animation: "run", keys: [{ bone: "tail", frame: 1 }] } });
    expect(out.result!.isError).toBe(true);
    expect((out.result!.content as Array<{ text: string }>)[0]!.text).toMatch(/no bone "tail"/);
  });

  it("refuses a page from another origin", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/agent/status`, { headers: { origin: "https://evil.example" } });
    expect(res.status).toBe(403);
  });

  it("runs Ask AI: the model's tool calls go to the page, and its answer comes back", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/chat`, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "What is in the rig?" }] }),
    });
    const body = await res.json() as { text: string; messages: unknown[] };
    expect(body.text).toBe("The rig has hips.");
    expect(apiRequests[0]!.tools.map((t) => t.name)).toContain("set_keys");
    // The second request carried the page's answer to get_rig.
    const toolResult = apiRequests[1]!.messages.at(-1)!.content as Array<{ type: string; content: string }>;
    expect(toolResult[0]!.type).toBe("tool_result");
    expect(toolResult[0]!.content).toContain("\"hips\"");
  });
});
