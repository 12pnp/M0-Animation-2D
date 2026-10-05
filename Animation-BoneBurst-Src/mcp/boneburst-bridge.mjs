#!/usr/bin/env node
// The AI bridge for BoneBurst. No dependencies: Node 18 or later.
//
//   node mcp/boneburst-bridge.mjs              MCP server on stdio (what Claude Code
//                                          and Claude Desktop start), plus the
//                                          HTTP side the editor page polls
//   node mcp/boneburst-bridge.mjs --http-only  just the HTTP side, for Ask AI
//
// The editor page (Window ▸ Connect to AI) long-polls GET /agent/next for tool
// calls and posts results to /agent/result. POST /chat runs the model with the
// same tools: Claude (Anthropic Messages) or GLM (OpenAI-compatible), picked by
// BONEBURST_PROVIDER. Keys come from the environment or the key file the popup's
// field writes (`POST /agent/key`) — either way they live in THIS process and
// its key file, never longer in the page than the paste.
// Listens on 127.0.0.1 only; only the editor's origins may call it.
//
// Environment: BONEBURST_BRIDGE_PORT (5190), BONEBURST_ORIGINS (comma separated;
// default the dev server, http://localhost:5181 and http://127.0.0.1:5181),
// BONEBURST_PROVIDER (anthropic | glm; glm when a GLM key is known), ANTHROPIC_API_KEY,
// GLM_API_KEY (api.z.ai; for open.bigmodel.cn also set BONEBURST_API_URL), BONEBURST_MODEL
// (claude-sonnet-5-5 / glm-4.6; the starting model — the dot popup's picker
// changes it live via POST /agent/model), BONEBURST_MODELS (the picker's choices,
// comma separated; a small built-in list per provider otherwise), BONEBURST_API_URL
// (the provider's endpoint; tests point it at a fake), BONEBURST_KEYFILE
// (~/.boneburst-bridge.json; where the popup's key field stores what it is given,
// mode 600, read back at startup).

import http from "node:http";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS = JSON.parse(readFileSync(join(HERE, "../src/app/agent/tools.json"), "utf8"));
/** A setting from the environment: `BONEBURST_<name>`, or the old
 *  `AMINO_<name>` from before the rename, so an existing setup keeps working. */
function env(name) {
  return process.env[`BONEBURST_${name}`] ?? process.env[`AMINO_${name}`];
}
const PORT = Number(env("BRIDGE_PORT") ?? 5190);
const ORIGINS = new Set((env("ORIGINS") ?? "http://localhost:5181,http://127.0.0.1:5181").split(",").map((s) => s.trim()));
const HTTP_ONLY = process.argv.includes("--http-only");
const log = (...a) => process.stderr.write(`[boneburst-bridge] ${a.join(" ")}\n`);

/* The chat providers: everything provider-specific about one LLM API. The
   conversation with the page stays Anthropic-shaped; each provider's turn()
   translates to its wire format and the reply back. */
const PROVIDERS = {
  anthropic: {
    label: "Claude", url: "https://api.anthropic.com/v1/messages", model: "claude-sonnet-5-5",
    keyName: "ANTHROPIC_API_KEY", turn: anthropicTurn,
  },
  glm: {
    label: "GLM", url: "https://api.z.ai/api/paas/v4/chat/completions", model: "glm-4.6",
    keyName: "GLM_API_KEY", turn: openaiTurn,
  },
};

/* The API keys: from the environment, or from the key file the popup's field
   writes — either way only this process holds them after that. */
const KEYFILE = env("KEYFILE") ?? join(homedir(), ".boneburst-bridge.json");
// The key file from before the rename is read when there is no new one yet;
// the next key saved goes to the new one.
const OLD_KEYFILE = join(homedir(), ".amino-bridge.json");
let savedKeys = {};
for (const file of env("KEYFILE") ? [KEYFILE] : [KEYFILE, OLD_KEYFILE]) {
  try { savedKeys = JSON.parse(readFileSync(file, "utf8")); break; } catch { /* none saved there */ }
}
const envAnthropic = process.env.ANTHROPIC_API_KEY ?? null;
const envGlm = process.env.GLM_API_KEY ?? process.env.Z_AI_API_KEY ?? null;
const keys = {
  anthropic: envAnthropic ?? (typeof savedKeys.anthropicKey === "string" ? savedKeys.anthropicKey : null),
  glm: envGlm ?? (typeof savedKeys.glmKey === "string" ? savedKeys.glmKey : null),
};
/** A key arriving from the page: kept in memory, saved to the key file (mode
 *  600) so the next start has it, and the provider switches to it. An empty
 *  key forgets the saved one. */
function setKey(name, key) {
  if (!PROVIDERS[name]) return { error: `Unknown provider "${name}".` };
  if (typeof key !== "string" || key.length > 4096) return { error: "That does not look like a key." };
  keys[name] = key || null;
  providerName = keys[name] ? name : (keys.glm ? "glm" : "anthropic");
  if (!modelChoices(providerName).includes(currentModel)) currentModel = provider().model;
  MODELS = [...new Set([...modelChoices(providerName), currentModel])];
  const file = { anthropicKey: keys.anthropic ?? undefined, glmKey: keys.glm ?? undefined };
  try {
    writeFileSync(KEYFILE, JSON.stringify(file), { mode: 0o600 });
    chmodSync(KEYFILE, 0o600);
  } catch (err) {
    log(`key file not written: ${err.message}`);
  }
  log(`${key ? "key set for" : "key cleared for"} ${name}; provider ${providerName}${key ? "" : " (no key)"}`);
  return { provider: providerName, chat: hasKey(), model: currentModel };
}

// A key given in the environment says which provider this start is for; a
// key that exists only in the key file auto-activates only then (GLM's first
// — the popup's field is GLM's).
const PROVIDER_NAME = env("PROVIDER")
  ?? (envAnthropic ? "anthropic" : envGlm ? "glm" : keys.glm ? "glm" : keys.anthropic ? "anthropic" : "anthropic");
if (!PROVIDERS[PROVIDER_NAME]) { log(`Unknown BONEBURST_PROVIDER "${PROVIDER_NAME}" (anthropic or glm).`); process.exit(1); }
/** The active provider — switched by whichever key arrives last
 *  (`POST /agent/key`); BONEBURST_PROVIDER is only its starting value. */
let providerName = PROVIDER_NAME;
const provider = () => PROVIDERS[providerName];
const apiUrl = () => env("API_URL") ?? provider().url;
/** The model Ask AI runs — switchable live (`POST /agent/model`); BONEBURST_MODEL
 *  is only its starting value. The choices the page offers: BONEBURST_MODELS
 *  (comma separated) or a small built-in list per provider, plus the current. */
const modelChoices = (name) => (env("MODELS")
  ?? { anthropic: "claude-sonnet-5-5", glm: "glm-4.6,glm-4.5,glm-4.5-air" }[name])
  .split(",").map((s) => s.trim()).filter(Boolean);
let currentModel = env("MODEL") ?? provider().model;
let MODELS = [...new Set([...modelChoices(providerName), currentModel])];
const hasKey = () => !!keys[providerName];
// Whether the model reads pictures: Claude does; GLM only its vision models
// (glm-4.5v, glm-4.6v…). BONEBURST_VISION=1 or 0 says so outright.
const vision = () => env("VISION") ? env("VISION") !== "0"
  : providerName === "anthropic" || /v$|v-|vision/i.test(currentModel);
// Pictures kept in a conversation sent to the model, newest first; older
// ones become a line of text. Each costs about a thousand tokens.
const KEEP_IMAGES = Number(env("KEEP_IMAGES") ?? 8);

/* ── pictures ── */

// A tool's value carries its pictures here (IMAGES_KEY in AgentApi.ts).
const IMAGES_KEY = "__images";

/** A tool value as text, and its pictures apart. */
function splitImages(value) {
  if (!value || typeof value !== "object" || !Array.isArray(value[IMAGES_KEY])) return { text: JSON.stringify(value), images: [] };
  const { [IMAGES_KEY]: images, ...rest } = value;
  return { text: JSON.stringify(rest), images };
}

const noVisionNote = () => `[a picture: ${currentModel} cannot see pictures; use a vision model (e.g. glm-4.5v) or set BONEBURST_VISION=1 if it can]`;
const DROPPED = "[an earlier picture, left out to save tokens]";

/** The conversation as sent to the model: pictures it cannot see turned into
 *  a note, and all but the newest KEEP_IMAGES turned into another. */
function forModel(convo) {
  let kept = 0;
  const swap = (b) => {
    if (b?.type !== "image") return b;
    if (!vision()) return { type: "text", text: noVisionNote() };
    return ++kept <= KEEP_IMAGES ? b : { type: "text", text: DROPPED };
  };
  const out = [];
  for (let i = convo.length - 1; i >= 0; i--) {
    const m = convo[i];
    if (!Array.isArray(m.content)) { out.unshift(m); continue; }
    const content = [...m.content].reverse().map((b) => (b.type === "tool_result" && Array.isArray(b.content)
      ? { ...b, content: [...b.content].reverse().map(swap).reverse() } : swap(b))).reverse();
    out.unshift({ ...m, content });
  }
  return out;
}

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
        ? "The editor is not connected. Open BoneBurst and choose Window ▸ Connect to AI."
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
  res.setHeader("x-boneburst-chat", hasKey() ? "1" : "0");
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
    res.setHeader("access-control-expose-headers", "x-boneburst-chat");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  } else if (origin) {
    return send(res, 403, { error: `Origin ${origin} may not use the bridge (BONEBURST_ORIGINS).` });
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
      return send(res, 200, { editor: Date.now() - lastSeen < 30000, chat: hasKey(), provider: providerName, model: currentModel, vision: vision() });
    }
    if (req.method === "GET" && url.pathname === "/agent/models") {
      return send(res, 200, { provider: providerName, model: currentModel, models: MODELS });
    }
    if (req.method === "POST" && url.pathname === "/agent/key") {
      const body = await readJson(req);
      const out = setKey(String(body.provider ?? ""), typeof body.key === "string" ? body.key.trim() : "");
      if (out.error) return send(res, 400, out);
      return send(res, 200, out);
    }
    if (req.method === "POST" && url.pathname === "/agent/provider") {
      const body = await readJson(req);
      const name = String(body.provider ?? "");
      if (!PROVIDERS[name]) return send(res, 400, { error: `Unknown provider "${name}".` });
      providerName = name;
      if (!modelChoices(providerName).includes(currentModel)) currentModel = provider().model;
      MODELS = [...new Set([...modelChoices(providerName), currentModel])];
      log(`provider: ${providerName}${hasKey() ? "" : " (no key)"}`);
      return send(res, 200, { provider: providerName, chat: hasKey(), model: currentModel });
    }
    if (req.method === "POST" && url.pathname === "/agent/model") {
      const body = await readJson(req);
      const model = typeof body.model === "string" ? body.model.trim() : "";
      if (!model || /[\r\n]/.test(model)) return send(res, 400, { error: "A model name is required." });
      currentModel = model;
      if (!MODELS.includes(model)) MODELS.push(model);
      log(`model: ${model}`);
      return send(res, 200, { model: currentModel });
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

/* ── Ask AI: Claude or GLM with the editor's tools ── */

const SYSTEM = `You rig and animate Spine 2D skeletons in BoneBurst, a timeline editor, through tools.
Conventions: x right, y UP, rotation in degrees counter-clockwise; key values are LOCAL to the parent bone and absolute (not offsets from the setup pose).
Work like an animator: call get_rig first to learn the bones, their setup poses and IK; read existing animations with get_animation when useful.
A looping animation keys the same pose at frame 0 and at its last frame. Prefer few keys with eases ("inout" for most body motion) over many linear keys; give one property its own ease with set_keys' "eases" (a hop: x linear, y "out" rising).
Use get_pose to check where bones end up (feet on the ground, hands where intended): it is the Spine runtime's pose, IK included.
Put many keys in one set_keys call: each call is ONE undo step for the user. End with check_preview on what you made, then show it, and tell the user briefly what you did.
When an animation has a reference (get_rig lists it), animate from it: get_reference for its timing and the images at a few key frames (contacts, extremes); pose each key frame with set_keys; check it with render_frame, which draws your skeleton over the reference with every bone named; adjust until the body lines up, then let eases fill between and look at a frame in between. Pictures cost tokens: look at key frames, not every frame. A picture the user attaches is the pose or the style to match.
To rig a character whose parts are layers (File ▸ Import PSD as Layers): render_frame with no animation, read the joints off the picture (pelvis, neck, head, and shoulders, elbows, wrists, hips, knees, ankles, toes per side) in skeleton space, and call auto_rig once; check the result with render_frame and fix single parts with attach. To rig by hand: get_rig lists the library's pictures and their sizes. Build the bones with add_bones in one call (joint and tip in skeleton space, parents first: hips, then spine, chest, neck, head; each limb in segments), attach each picture to its bone with its joint as the pivot, order the near and far limbs with draw_order, and add IK to legs (and arms when wanted) with add_ik. Look at the setup pose with render_frame (no animation) and fix what is off before animating.
For a walk, run, idle, jump or wave, start from the motion library: list_motions, then apply_motion (check the role mapping it reports), look at a few frames with render_frame, and refine with set_keys.`;

async function chat(messages) {
  const key = keys[providerName];
  if (!key) throw new Error(`The bridge has no ${provider().keyName}: start it with the key, or paste one in the AI panel's status popup.`);
  const convo = [...messages];
  for (let turn = 0; turn < 24; turn++) {
    const reply = await provider().turn(forModel(convo), key);
    convo.push({ role: "assistant", content: reply.blocks });
    const uses = reply.blocks.filter((b) => b.type === "tool_use");
    if (!reply.toolUse || uses.length === 0) {
      return { messages: convo, text: reply.blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n") };
    }
    const results = [];
    for (const use of uses) {
      try {
        const { text, images } = splitImages(await callPage(use.name, use.input));
        results.push({
          type: "tool_result", tool_use_id: use.id,
          content: images.length
            ? [{ type: "text", text }, ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.data } }))]
            : text,
        });
      } catch (err) {
        results.push({ type: "tool_result", tool_use_id: use.id, content: err.message, is_error: true });
      }
    }
    convo.push({ role: "user", content: results });
  }
  return { messages: convo, text: "(Stopped after 24 steps.)" };
}

/** One Anthropic Messages call (Claude): request and reply already in the bridge's format. */
async function anthropicTurn(convo, key) {
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({
      model: currentModel, max_tokens: 8000, system: SYSTEM,
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      messages: convo,
    }),
  });
  const reply = await res.json();
  if (!res.ok) throw new Error(reply?.error?.message ?? `Claude API ${res.status}`);
  return { blocks: reply.content, toolUse: reply.stop_reason === "tool_use" };
}

/** One OpenAI-compatible call (GLM): the conversation is translated to
    chat-completions format and the reply back, so /chat stays Anthropic-shaped. */
async function openaiTurn(convo, key) {
  // Anthropic's image block as a chat-completions content part.
  const part = (b) => (b.type === "image"
    ? { type: "image_url", image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
    : { type: "text", text: b.text ?? "" });
  const toOpenAI = (m) => {
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === "user" && typeof m.content === "string") return [{ role: "user", content: m.content }];
    if (m.role === "assistant") {
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
      const tool_calls = blocks.filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      return [{ role: "assistant", content: text || null, ...(tool_calls.length ? { tool_calls } : {}) }];
    }
    const results = blocks.filter((b) => b.type === "tool_result");
    if (results.length === 0) return [{ role: "user", content: blocks.map(part) }];
    // A tool message is text only: the pictures follow as the user's.
    const out = [];
    const pictures = [];
    for (const b of results) {
      const content = Array.isArray(b.content) ? b.content : [{ type: "text", text: String(b.content) }];
      out.push({ role: "tool", tool_call_id: b.tool_use_id, content: content.filter((c) => c.type !== "image").map((c) => c.text).join("\n") });
      pictures.push(...content.filter((c) => c.type === "image").map(part));
    }
    if (pictures.length) out.push({ role: "user", content: [{ type: "text", text: "The pictures the tools above returned:" }, ...pictures] });
    return out;
  };
  const res = await fetch(apiUrl(), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: currentModel, max_tokens: 8000,
      messages: [{ role: "system", content: SYSTEM }, ...convo.flatMap(toOpenAI)],
      tools: TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } })),
    }),
  });
  const reply = await res.json();
  if (!res.ok) throw new Error(reply?.error?.message ?? `GLM API ${res.status}`);
  const choice = reply.choices[0];
  const blocks = [];
  if (choice.message.content) blocks.push({ type: "text", text: choice.message.content });
  for (const call of choice.message.tool_calls ?? []) {
    blocks.push({ type: "tool_use", id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments || "{}") });
  }
  return { blocks, toolUse: choice.finish_reason === "tool_calls" };
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
        serverInfo: { name: "boneburst", version: "0.1.0" },
        instructions: SYSTEM + "\nThe tools act on the skeleton open in the BoneBurst editor tab (Window ▸ Connect to AI).",
      });
    case "ping":
      return reply({});
    case "tools/list":
      return reply({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
    case "tools/call": {
      const name = msg.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return fail(-32602, `Unknown tool: ${name}`);
      try {
        const { text, images } = splitImages(await callPage(name, msg.params?.arguments ?? {}));
        return reply({ content: [
          { type: "text", text: JSON.stringify(JSON.parse(text), null, 1) },
          ...images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })),
        ] });
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
