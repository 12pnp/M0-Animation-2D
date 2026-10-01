import { type ChildProcess, spawn } from "node:child_process";
import http from "node:http";
import { readFile, rm, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { reseed } from "@/core/doc/ids";
import { Store } from "@/app/Store";
import { AGENT_TOOLS, AgentApi, AgentError, type AgentVision } from "@/app/agent/AgentApi";
import type { AssetId } from "@/core/doc/ids";
import type { SymbolItem } from "@/core/doc/types";
import { loadStickman } from "./fixtures/stickman";

/**
 * `mcp/amino-bridge.mjs` as Claude Code runs it: MCP over stdio on one side,
 * the editor page's long poll on the other. The "page" here is a real
 * `AgentApi` on the stickman, polling as `AgentBridge` does; the model APIs
 * for Ask AI are fakes that ask for one tool and then answer — Anthropic
 * Messages for Claude, chat completions for GLM.
 */

const BRIDGE = fileURLToPath(new URL("../mcp/amino-bridge.mjs", import.meta.url));
const PORT = 5391, API_PORT = 5392, GLM_PORT = 5393, GLM_API_PORT = 5394, GLMV_PORT = 5395;
const ORIGIN = "http://localhost:5181";

let bridge: ChildProcess;
let fakeApi: http.Server;
const apiRequests: Array<{ messages: Array<{ role: string; content: unknown }>; tools: Array<{ name: string }> }> = [];
let glmBridge: ChildProcess;
let glmVisionBridge: ChildProcess;
/** The tool the fake models ask for when handed a question. */
let askFor: { name: string; input: Record<string, unknown> } = { name: "get_rig", input: {} };
let glmApi: http.Server;
const glmRequests: Array<{ model?: string; messages: Array<{ role: string; tool_call_id?: string; content: unknown }>; tools: Array<{ type?: string }>; authorization?: string }> = [];
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
async function runPage(api: AgentApi, port = PORT): Promise<void> {
  while (pageRunning) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/agent/next`, { headers: { origin: ORIGIN } });
      if (res.status === 204) continue;
      const call = await res.json() as { id: string; name: string; args: Record<string, unknown> };
      let body: Record<string, unknown>;
      try { body = { id: call.id, ok: true, value: await api.call(call.name, call.args) }; } catch (err) {
        body = { id: call.id, ok: false, error: err instanceof AgentError ? err.message : String(err) };
      }
      await fetch(`http://127.0.0.1:${port}/agent/result`, { method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

beforeAll(async () => {
  reseed();
  const { project } = await loadStickman();
  const sym = project.items[project.rootSymbolId] as SymbolItem;
  sym.animations.find((a) => a.name === "run")!.reference = {
    frames: ["r1"] as AssetId[], width: 10, height: 20, at: [0], hold: 30, start: 0, x: -5, y: -20, scale: 10,
  };
  // The page's canvases, faked: a picture is a tag.
  const vision: AgentVision = {
    image: async (id) => ({ mimeType: "image/png", data: `IMG_${id}` }),
    render: async () => ({ mimeType: "image/png", data: "RENDER" }),
  };
  const api = new AgentApi(new Store(project), undefined, vision);

  // A fake Messages API: asks for `askFor` when handed a question, then
  // says it is done.
  fakeApi = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    apiRequests.push(body);
    const last = body.messages.at(-1).content;
    const first = typeof last === "string" || !last.some((b: { type: string }) => b.type === "tool_result");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(first
      ? { content: [{ type: "tool_use", id: "tu1", name: askFor.name, input: askFor.input }], stop_reason: "tool_use" }
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

  // The same bridge on GLM (GLM_API_KEY alone picks the provider), against a
  // fake chat-completions API: first asks for get_rig, then answers.
  glmApi = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    glmRequests.push({ ...body, authorization: req.headers.authorization });
    const first = !body.messages.some((m: { role: string }) => m.role === "tool");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(first
      ? { choices: [{ message: { content: null, tool_calls: [{ id: "call1", type: "function", function: { name: askFor.name, arguments: JSON.stringify(askFor.input) } }] }, finish_reason: "tool_calls" }] }
      : { choices: [{ message: { content: "The rig has hips." }, finish_reason: "stop" }] }));
  });
  await new Promise<void>((r) => glmApi.listen(GLM_API_PORT, "127.0.0.1", r));

  const env: NodeJS.ProcessEnv = { ...process.env, AMINO_BRIDGE_PORT: String(GLM_PORT), GLM_API_KEY: "test-glm", AMINO_API_URL: `http://127.0.0.1:${GLM_API_PORT}/chat/completions` };
  delete env.AMINO_PROVIDER; // auto-detect: GLM_API_KEY means glm
  glmBridge = spawn("node", [BRIDGE], { stdio: ["pipe", "pipe", "pipe"], env });
  glmBridge.stdout!.resume(); // no MCP over stdio for this one
  await new Promise<void>((r) => glmBridge.stderr!.once("data", () => r()));
  void runPage(api, GLM_PORT);

  // GLM with a vision model: AMINO_VISION=1 says it reads pictures.
  glmVisionBridge = spawn("node", [BRIDGE], { stdio: ["pipe", "pipe", "pipe"], env: { ...env, AMINO_BRIDGE_PORT: String(GLMV_PORT), AMINO_VISION: "1" } });
  glmVisionBridge.stdout!.resume();
  await new Promise<void>((r) => glmVisionBridge.stderr!.once("data", () => r()));
  void runPage(api, GLMV_PORT);
});

afterAll(async () => {
  pageRunning = false;
  bridge?.kill();
  glmBridge?.kill();
  glmVisionBridge?.kill();
  await new Promise((r) => fakeApi.close(r));
  await new Promise((r) => glmApi.close(r));
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

describe("the AI bridge on GLM", () => {
  it("reports which provider it runs", async () => {
    const res = await fetch(`http://127.0.0.1:${GLM_PORT}/agent/status`, { headers: { origin: ORIGIN } });
    expect(await res.json()).toMatchObject({ chat: true, provider: "glm", model: "glm-4.6" });
  });

  it("runs Ask AI through chat-completions format and answers in the page's format", async () => {
    const res = await fetch(`http://127.0.0.1:${GLM_PORT}/chat`, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "What is in the rig?" }] }),
    });
    const body = await res.json() as { text: string; messages: Array<{ role: string; content: unknown }> };
    expect(body.text).toBe("The rig has hips.");
    // Outgoing: Bearer auth, a system message first, the tools as functions.
    expect(glmRequests[0]!.authorization).toBe("Bearer test-glm");
    expect(glmRequests[0]!.messages[0]).toMatchObject({ role: "system" });
    expect(glmRequests[0]!.tools.every((t) => t.type === "function")).toBe(true);
    // The second request carried the page's answer as a tool message.
    const tool = glmRequests[1]!.messages.at(-1) as { role: string; tool_call_id?: string; content: string };
    expect(tool).toMatchObject({ role: "tool", tool_call_id: "call1" });
    expect(tool.content).toContain("\"hips\"");
    // Back to the page: the model's tool call came back in Anthropic shape.
    const said = body.messages.find((m) => m.role === "assistant")!;
    expect(said.content).toEqual([{ type: "tool_use", id: "call1", name: "get_rig", input: {} }]);
  });

  it("lists its models, and a live switch changes what /chat sends", async () => {
    const origin = { origin: ORIGIN };
    const before = await (await fetch(`http://127.0.0.1:${GLM_PORT}/agent/models`, { headers: origin })).json();
    expect(before).toMatchObject({ provider: "glm", model: "glm-4.6" });
    expect(before.models).toEqual(expect.arrayContaining(["glm-4.6", "glm-4.5", "glm-4.5-air"]));

    const set = await fetch(`http://127.0.0.1:${GLM_PORT}/agent/model`, {
      method: "POST", headers: { ...origin, "content-type": "application/json" }, body: JSON.stringify({ model: "glm-test-air" }),
    });
    expect(await set.json()).toEqual({ model: "glm-test-air" });
    const after = await (await fetch(`http://127.0.0.1:${GLM_PORT}/agent/models`, { headers: origin })).json();
    expect(after.model).toBe("glm-test-air");
    expect(after.models).toContain("glm-test-air");
    const status = await (await fetch(`http://127.0.0.1:${GLM_PORT}/agent/status`, { headers: origin })).json();
    expect(status.model).toBe("glm-test-air");

    await fetch(`http://127.0.0.1:${GLM_PORT}/chat`, {
      method: "POST", headers: { ...origin, "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "What is in the rig?" }] }),
    });
    expect(glmRequests.at(-1)!.model).toBe("glm-test-air");

    await fetch(`http://127.0.0.1:${GLM_PORT}/agent/model`, {
      method: "POST", headers: { ...origin, "content-type": "application/json" }, body: JSON.stringify({ model: "glm-4.6" }),
    });
  });

  it("refuses an empty model", async () => {
    const res = await fetch(`http://127.0.0.1:${GLM_PORT}/agent/model`, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ model: "  " }),
    });
    expect(res.status).toBe(400);
  });
});

describe("a key pasted in the popup", () => {
  const PORT = 5396;
  const keyfile = fileURLToPath(new URL("./fixtures/bridge-key.json", import.meta.url));
  let keyBridge: ChildProcess;

  beforeAll(async () => {
    await rm(keyfile, { force: true });
    keyBridge = spawn("node", [BRIDGE], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AMINO_BRIDGE_PORT: String(PORT), AMINO_KEYFILE: keyfile },
    });
    keyBridge.stdout!.resume();
    await new Promise<void>((r) => keyBridge.stderr!.once("data", () => r()));
  });
  afterAll(async () => {
    keyBridge?.kill();
    await rm(keyfile, { force: true });
  });

  const origin = () => ({ origin: ORIGIN });

  it("turns a keyless bridge into a keyed GLM one, and the file remembers it", async () => {
    const before = await (await fetch(`http://127.0.0.1:${PORT}/agent/status`, { headers: origin() })).json() as Record<string, unknown>;
    expect(before).toMatchObject({ chat: false, provider: "anthropic" });

    const set = await fetch(`http://127.0.0.1:${PORT}/agent/key`, {
      method: "POST", headers: { ...origin(), "content-type": "application/json" },
      body: JSON.stringify({ provider: "glm", key: "test-key-from-popup" }),
    });
    expect(await set.json()).toMatchObject({ provider: "glm", chat: true, model: "glm-4.6" });

    const after = await (await fetch(`http://127.0.0.1:${PORT}/agent/status`, { headers: origin() })).json() as Record<string, unknown>;
    expect(after).toMatchObject({ chat: true, provider: "glm", model: "glm-4.6" });
    // The key itself is never said back.
    expect(JSON.stringify(after)).not.toContain("test-key-from-popup");

    const file = JSON.parse(await readFile(keyfile, "utf8")) as { glmKey?: string };
    expect(file.glmKey).toBe("test-key-from-popup");
    const mode = (await stat(keyfile)).mode & 0o777;
    expect(mode & 0o077).toBe(0); // only the owner may read it
  });

  it("hands the saved key to the next start on its own", async () => {
    const fresh = spawn("node", [BRIDGE], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, AMINO_BRIDGE_PORT: String(PORT + 1), AMINO_KEYFILE: keyfile },
    });
    fresh.stdout!.resume();
    await new Promise<void>((r) => fresh.stderr!.once("data", () => r()));
    const status = await (await fetch(`http://127.0.0.1:${PORT + 1}/agent/status`, { headers: origin() })).json() as Record<string, unknown>;
    expect(status).toMatchObject({ chat: true, provider: "glm" });
    fresh.kill();
  });

  it("refuses junk", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/agent/key`, {
      method: "POST", headers: { ...origin(), "content-type": "application/json" },
      body: JSON.stringify({ provider: "nope", key: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("switches provider on the panel's tab, model list following", async () => {
    const toClaude = await fetch(`http://127.0.0.1:${PORT}/agent/provider`, {
      method: "POST", headers: { ...origin(), "content-type": "application/json" },
      body: JSON.stringify({ provider: "anthropic" }),
    });
    expect(await toClaude.json()).toMatchObject({ provider: "anthropic", chat: false, model: "claude-sonnet-5-5" });
    const models = await (await fetch(`http://127.0.0.1:${PORT}/agent/models`, { headers: origin() })).json();
    expect(models.models).toEqual(["claude-sonnet-5-5"]);

    const back = await fetch(`http://127.0.0.1:${PORT}/agent/provider`, {
      method: "POST", headers: { ...origin(), "content-type": "application/json" },
      body: JSON.stringify({ provider: "glm" }),
    });
    expect(await back.json()).toMatchObject({ provider: "glm", chat: true, model: "glm-4.6" });
  });
});

describe("pictures through the bridge", () => {
  const chat = async (port: number, messages: unknown[]) => {
    const res = await fetch(`http://127.0.0.1:${port}/chat`, {
      method: "POST", headers: { origin: ORIGIN, "content-type": "application/json" }, body: JSON.stringify({ messages }),
    });
    return await res.json() as { text: string; messages: Array<{ role: string; content: unknown }> };
  };
  const picture = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });

  it("hands a tool's picture to an MCP client as image content, not as text", async () => {
    const out = await rpc("tools/call", { name: "render_frame", arguments: { animation: "run", frame: 3 } });
    const content = out.result!.content as Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
    expect(content[1]).toEqual({ type: "image", data: "RENDER", mimeType: "image/png" });
    expect(content[0]!.text).not.toContain("__images");
    expect(JSON.parse(content[0]!.text!).mapping).toMatch(/px/);
  });

  it("sends Claude the user's picture and the tool's, and only the newest eight", async () => {
    askFor = { name: "render_frame", input: { animation: "run", frame: 3 } };
    const from = apiRequests.length;
    // Nine pictures earlier in the conversation (every other message), one
    // attached now, one the tool returns: eleven, of which eight are sent.
    const earlier = Array.from({ length: 18 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: i % 2 ? [{ type: "text", text: "ok" }] : [picture(`OLD${i}`), { type: "text", text: "look" }] }));
    const body = await chat(PORT, [...earlier, { role: "user", content: [picture("MINE"), { type: "text", text: "Pose it like this." }] }]);
    expect(body.text).toBe("The rig has hips.");
    const pics = (req: { messages: Array<{ content: unknown }> }) => JSON.stringify(req.messages).match(/"data":"[A-Z0-9_]+"/g) ?? [];
    expect(pics(apiRequests[from]!)).toContain('"data":"MINE"');
    // The second call carries the render as an image block in the tool result.
    const result = (apiRequests[from + 1]!.messages.at(-1)!.content as Array<{ type: string; content: Array<{ type: string; source?: { data: string } }> }>)[0]!;
    expect(result.type).toBe("tool_result");
    expect(result.content[1]).toEqual(picture("RENDER"));
    expect(pics(apiRequests[from + 1]!)).toHaveLength(8);
    expect(pics(apiRequests[from + 1]!)).not.toContain('"data":"OLD0"');
    expect(JSON.stringify(apiRequests[from + 1]!.messages)).toContain("left out to save tokens");
    // The page keeps every picture: the trimming is only what is sent.
    expect(JSON.stringify(body.messages)).toContain("OLD0");
  });

  it("tells a GLM model that cannot see that a picture was there, and sends it none", async () => {
    askFor = { name: "render_frame", input: { animation: "run", frame: 3 } };
    const from = glmRequests.length;
    await chat(GLM_PORT, [{ role: "user", content: "Show me frame 3." }]);
    const sent = JSON.stringify(glmRequests[from + 1]!.messages);
    expect(sent).not.toContain("image_url");
    expect(sent).toContain("cannot see pictures");
  });

  it("gives a GLM vision model the tool's picture right after the tool's text", async () => {
    askFor = { name: "get_reference", input: { animation: "run", frames: [0] } };
    const from = glmRequests.length;
    await chat(GLMV_PORT, [{ role: "user", content: "What does the reference show?" }]);
    const msgs = glmRequests[from + 1]!.messages;
    const tool = msgs.findIndex((m) => m.role === "tool");
    expect(msgs[tool]!.content).toMatch(/keyFrames/);
    expect(msgs[tool + 1]).toMatchObject({ role: "user" });
    expect(JSON.stringify(msgs[tool + 1]!.content)).toContain("data:image/png;base64,IMG_r1");
    askFor = { name: "get_rig", input: {} };
  });
});
