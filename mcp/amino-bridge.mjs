#!/usr/bin/env node
// The AI bridge for Amino Spine2D. No dependencies: Node 18 or later.
//
//   node mcp/amino-bridge.mjs              MCP server on stdio (what Claude Code
//                                          and Claude Desktop start), plus the
//                                          HTTP side the editor page polls
//   node mcp/amino-bridge.mjs --http-only  just the HTTP side, for Ask AI
//
// The editor page (Window ▸ Connect to AI) long-polls GET /agent/next for tool
// calls and posts results to /agent/result. POST /chat runs Claude with the
// same tools (the key is ANTHROPIC_API_KEY in THIS process, never in the page).
// Listens on 127.0.0.1 only; only the editor's origins may call it.
//
// Environment: AMINO_BRIDGE_PORT (5190), AMINO_ORIGINS (comma separated;
// default the dev server, http://localhost:5181 and http://127.0.0.1:5181),
// ANTHROPIC_API_KEY, AMINO_MODEL (claude-sonnet-5-5), AMINO_API_URL (the
// Messages endpoint; tests point it at a fake).

import http from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = JSON.parse(readFileSync(join(HERE, "../src/app/agent/tools.json"), "utf8"));
const PORT = Number(process.env.AMINO_BRIDGE_PORT ?? 5190);
const ORIGINS = new Set((process.env.AMINO_ORIGINS ?? "http://localhost:5181,http://127.0.0.1:5181").split(",").map((s) => s.trim()));
const MODEL = process.env.AMINO_MODEL ?? "claude-sonnet-5-5";
const API_URL = process.env.AMINO_API_URL ?? "https://api.anthropic.com/v1/messages";
const HTTP_ONLY = process.argv.includes("--http-only");
const log = (...a) => process.stderr.write(`[amino-bridge] ${a.join(" ")}\n`);

/* ── the page: calls waiting for it, and the one poll waiting for a call ── */

const queue = [];
const pending = new Map();
let poller = null;
let lastSeen = 0;

function callPage(name, args, timeoutMs = 120000) {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(Date.now() - lastSeen > 30000
        ? "The editor is not connected. Open Amino Spine2D and choose Window ▸ Connect to AI."
        : `The editor did not answer "${name}" in time.`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    queue.push({ id, name, args });
    flush();
  });
}

function flush() {
  if (!poller || queue.length === 0) return;
  const { res } = poller;
  clearTimeout(poller.timer);
  poller = null;
  send(res, 200, queue.shift());
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("x-amino-chat", process.env.ANTHROPIC_API_KEY ? "1" : "0");
  if (body === undefined) { res.end(); return; }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && ORIGINS.has(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-expose-headers", "x-amino-chat");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  } else if (origin) {
    return send(res, 403, { error: `Origin ${origin} may not use the bridge (AMINO_ORIGINS).` });
  }
  if (req.method === "OPTIONS") return send(res, 204);
  const url = new URL(req.url, "http://x");
  try {
    if (req.method === "GET" && url.pathname === "/agent/next") {
      lastSeen = Date.now();
      if (poller) { clearTimeout(poller.timer); send(poller.res, 204); }
      const timer = setTimeout(() => { if (poller?.res === res) { poller = null; send(res, 204); } }, 25000);
      poller = { res, timer };
      req.on("close", () => { if (poller?.res === res) { clearTimeout(timer); poller = null; } });
      return flush();
    }
    if (req.method === "POST" && url.pathname === "/agent/result") {
      lastSeen = Date.now();
      const body = await readJson(req);
      const p = pending.get(body.id);
      if (p) {
        pending.delete(body.id);
        clearTimeout(p.timer);
        if (body.ok) p.resolve(body.value); else p.reject(Object.assign(new Error(body.error), { fromEditor: true }));
      }
      return send(res, 204);
    }
    if (req.method === "GET" && url.pathname === "/agent/status") {
      return send(res, 200, { editor: Date.now() - lastSeen < 30000, chat: !!process.env.ANTHROPIC_API_KEY, model: MODEL });
    }
    if (req.method === "POST" && url.pathname === "/chat") {
      const body = await readJson(req);
      return send(res, 200, await chat(body.messages ?? []));
    }
    send(res, 404, { error: "not found" });
  } catch (err) {
    send(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.on("error", (err) => { log(`HTTP: ${err.message}`); process.exit(1); });
server.listen(PORT, "127.0.0.1", () => log(`HTTP on http://127.0.0.1:${PORT} for ${[...ORIGINS].join(", ")}`));

/* ── Ask AI: Claude with the editor's tools ── */

const SYSTEM = `You animate Spine 2D skeletons in Amino Spine2D, a timeline editor, through tools.
Conventions: x right, y UP, rotation in degrees counter-clockwise; key values are LOCAL to the parent bone and absolute (not offsets from the setup pose).
Work like an animator: call get_rig first to learn the bones, their setup poses and IK; read existing animations with get_animation when useful.
A looping animation keys the same pose at frame 0 and at its last frame. Prefer few keys with eases ("inout" for most body motion) over many linear keys; give one property its own ease with set_keys' "eases" (a hop: x linear, y "out" rising).
Use get_pose to check where bones end up (feet on the ground, hands where intended): it is the Spine runtime's pose, IK included.
Put many keys in one set_keys call: each call is ONE undo step for the user. End with check_preview on what you made, then show it, and tell the user briefly what you did.`;

async function chat(messages) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("The bridge has no ANTHROPIC_API_KEY: start it with the key in its environment.");
  const convo = [...messages];
  const tools = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  for (let turn = 0; turn < 24; turn++) {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens: 8000, system: SYSTEM, tools, messages: convo }),
    });
    const reply = await res.json();
    if (!res.ok) throw new Error(reply?.error?.message ?? `Claude API ${res.status}`);
    convo.push({ role: "assistant", content: reply.content });
    const uses = reply.content.filter((b) => b.type === "tool_use");
    if (reply.stop_reason !== "tool_use" || uses.length === 0) {
      return { messages: convo, text: reply.content.filter((b) => b.type === "text").map((b) => b.text).join("\n") };
    }
    const results = [];
    for (const use of uses) {
      try {
        results.push({ type: "tool_result", tool_use_id: use.id, content: JSON.stringify(await callPage(use.name, use.input)) });
      } catch (err) {
        results.push({ type: "tool_result", tool_use_id: use.id, content: err.message, is_error: true });
      }
    }
    convo.push({ role: "user", content: results });
  }
  return { messages: convo, text: "(Stopped after 24 steps.)" };
}

/* ── MCP over stdio: newline-delimited JSON-RPC 2.0 ── */

const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

async function handle(msg) {
  const reply = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: PROTOCOLS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : PROTOCOLS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "amino-spine2d", version: "0.1.0" },
        instructions: SYSTEM + "\nThe tools act on the skeleton open in the Amino Spine2D editor tab (Window ▸ Connect to AI).",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
    case "tools/call": {
      const name = msg.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      try {
        const value = await callPage(name, msg.params?.arguments ?? {});
        return reply({ content: [{ type: "text", text: JSON.stringify(value, null, 1) }] });
      } catch (err) {
        return reply({ content: [{ type: "text", text: err.message }], isError: true });
      }
    }
    default:
      return msg.id === undefined ? null : fail(-32601, `Method not found: ${msg.method}`);
  }
}

if (!HTTP_ONLY) {
  let buffer = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }) + "\n"); continue; }
      handle(msg).then((out) => { if (out) process.stdout.write(JSON.stringify(out) + "\n"); });
    }
  });
  process.stdin.on("end", () => process.exit(0));
}
