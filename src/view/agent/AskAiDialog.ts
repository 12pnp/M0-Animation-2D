import { h, on } from "@/view/widgets/dom";
import { Modal } from "@/view/widgets/Modal";
import type { AgentBridge, BridgeState } from "@/app/agent/AgentBridge";

/**
 * AI ▸ Ask AI…: a conversation with Claude or GLM about the open rig. The
 * bridge process runs the model with the editor's tools (the API key stays
 * there); every edit the model makes is an ordinary undo step, labelled
 * "AI: …". The conversation lasts as long as the page.
 *
 * Both AI windows say at the top whether the bridge is there and which model
 * it chats with, and connect or disconnect on the spot: a question typed
 * into a window that cannot answer is the failure this layout is for.
 */

let conversation: unknown[] = [];

const EXAMPLES = [
  "Describe this rig: its bones, IK and animations.",
  "Make a 24-frame walk cycle that loops.",
  "Make a 40-frame idle: slow breathing, a small head bob.",
  "Make a 16-frame hop: the body rises and lands, x moves linearly.",
];

/** This checkout's bridge when the dev server knows it (`__BRIDGE_PATH__`,
 *  `vite.config.ts`). */
function bridgePath(): string {
  return typeof __BRIDGE_PATH__ === "string" && __BRIDGE_PATH__ ? __BRIDGE_PATH__ : "<path to Amino-Spine2D-Src>/mcp/amino-bridge.mjs";
}

/** A connection strip: a light, what it means, and the button that changes it. */
function statusStrip(bridge: AgentBridge, toggle: () => void): { el: HTMLElement; dispose: () => void } {
  const dot = h("span", { class: "ai-dot" });
  const text = h("span", { class: "ai-status-text" });
  const btn = h("button", { class: "btn" }) as HTMLButtonElement;
  const el = h("div", { class: "ai-status" }, dot, text, h("div", { class: "spacer" }), btn);
  on(btn, "pointerup", toggle);
  let asked = 0;
  const sync = (state: BridgeState) => {
    dot.dataset.state = state === "connected" ? (bridge.chatReady ? "ready" : "mcp") : state;
    text.textContent = state === "off" ? "Not connected to the AI bridge."
      : state === "connecting" ? "Looking for the AI bridge… (start it: AI ▸ Connecting AI…)"
      : bridge.chatReady ? "Connected. Ask AI is ready."
      : "Connected for MCP (Claude Code / Desktop). Ask AI here needs the bridge started with an API key.";
    btn.textContent = state === "off" ? "Connect" : "Disconnect";
    if (state === "connected" && bridge.chatReady) {
      const ask = ++asked;
      void bridge.info().then((info) => {
        if (ask === asked && info && bridge.state === "connected") text.textContent = `Connected. Ask AI is ready: ${info.provider === "glm" ? "GLM" : "Claude"} (${info.model}).`;
      });
    }
  };
  sync(bridge.state);
  return { el, dispose: bridge.onState((s) => sync(s)) };
}

export function openAskAi(bridge: AgentBridge, toggleConnection: () => void): void {
  const strip = statusStrip(bridge, toggleConnection);
  const modal = new Modal({ title: "Ask AI", width: 900, height: 720, onClose: () => strip.dispose() });

  const log = h("div", { class: "ai-log" });
  const input = h("textarea", { class: "ai-input", placeholder: "Ask the AI to animate the open rig…  (⌘↩ to send)", rows: "4" }) as HTMLTextAreaElement;
  const send = h("button", { class: "btn primary ai-send" }, "Send") as HTMLButtonElement;
  const reset = h("button", { class: "btn" }, "New conversation") as HTMLButtonElement;
  const note = h("div", { class: "ai-hint" }, "Each edit the AI makes is one undo step, named \"AI: …\" in History.");
  modal.body.classList.add("ai-body");
  modal.body.append(strip.el, log, h("div", { class: "ai-compose" }, input, send));
  modal.footer.append(note, h("div", { class: "spacer" }), reset);

  const say = (who: "you" | "ai" | "note", text: string) => {
    log.querySelector(".ai-empty")?.remove();
    const row = h("div", { class: `ai-msg ai-${who}` },
      who === "note" ? null : h("div", { class: "ai-who" }, who === "you" ? "You" : "AI"),
      h("div", { class: "ai-text" }, text));
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
    return row;
  };

  const empty = () => {
    const chips = h("div", { class: "ai-examples" });
    for (const ex of EXAMPLES) {
      const chip = h("button", { class: "ai-example" }, ex);
      on(chip, "pointerup", () => { input.value = ex; input.focus(); });
      chips.appendChild(chip);
    }
    log.appendChild(h("div", { class: "ai-empty" },
      h("div", { class: "ai-empty-title" }, "What should the rig do?"),
      h("div", { class: "ai-empty-sub" }, "The AI reads the rig, keys the bones, checks the result in the Spine runtime, and shows it to you."),
      chips));
  };

  for (const m of conversation as Array<{ role: string; content: unknown }>) {
    if (m.role === "user" && typeof m.content === "string") say("you", m.content);
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const text = (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (text) say("ai", text);
    }
  }
  if (!log.childElementCount) empty();

  const problem = () => {
    if (bridge.state !== "connected") return "Not connected: press Connect above, with the bridge running (AI ▸ Connecting AI…).";
    if (!bridge.chatReady) return "The bridge has no API key: start it with ANTHROPIC_API_KEY or GLM_API_KEY set, or use Claude Code over MCP instead.";
    return "";
  };

  const go = async () => {
    const text = input.value.trim();
    if (!text || send.disabled) return;
    const why = problem();
    if (why) { say("note", why); return; }
    say("you", text);
    input.value = "";
    send.disabled = true;
    const working = say("note", "Working… the stage updates as the AI edits.");
    working.classList.add("ai-working");
    try {
      const out = await bridge.chat([...conversation, { role: "user", content: text }]);
      conversation = out.messages;
      working.remove();
      say("ai", out.text || "(done)");
    } catch (err) {
      working.remove();
      say("note", err instanceof Error ? err.message : String(err));
    } finally {
      send.disabled = false;
      input.focus();
    }
  };
  on(send, "pointerup", () => void go());
  on(input, "keydown", (e) => {
    const k = e as unknown as KeyboardEvent;
    if (k.key === "Enter" && (k.metaKey || k.ctrlKey)) { k.preventDefault(); void go(); }
  });
  on(reset, "pointerup", () => { conversation = []; log.replaceChildren(); empty(); input.focus(); });
  input.focus();
}

/** AI ▸ Connecting AI…: how to start the bridge and point a model at it. */
export function openAiHelp(bridge: AgentBridge, toggleConnection: () => void): void {
  const strip = statusStrip(bridge, toggleConnection);
  const modal = new Modal({ title: "Connecting AI", width: 820, onClose: () => strip.dispose() });
  const path = bridgePath();

  const code = (text: string) => {
    const copy = h("button", { class: "btn ai-copy" }, "Copy") as HTMLButtonElement;
    on(copy, "pointerup", () => {
      void navigator.clipboard?.writeText(text).then(() => {
        copy.textContent = "Copied";
        setTimeout(() => { copy.textContent = "Copy"; }, 1200);
      });
    });
    return h("div", { class: "ai-code" }, h("pre", {}, text), copy);
  };
  const step = (n: number, title: string, ...rest: HTMLElement[]) =>
    h("div", { class: "ai-step" }, h("div", { class: "ai-step-n" }, String(n)),
      h("div", { class: "ai-step-body" }, h("div", { class: "ai-step-title" }, title), ...rest));

  modal.body.classList.add("ai-body", "ai-help");
  modal.body.append(
    strip.el,
    h("p", {}, "The AI edits this tab through the bridge, a small program on this computer (mcp/amino-bridge.mjs). The page talks to it on 127.0.0.1 only; nothing leaves your machine except what the model itself sends."),
    h("h3", {}, "Ask AI, in this window (Claude or GLM)"),
    step(1, "Start the bridge in a terminal, with your API key. Claude:",
      code(`ANTHROPIC_API_KEY=sk-ant-… node "${path}" --http-only`),
      h("div", { class: "ai-hint" }, "or GLM (api.z.ai; for a bigmodel.cn key also set AMINO_API_URL=https://open.bigmodel.cn/api/paas/v4/chat/completions, and AMINO_MODEL to pick a model):"),
      code(`GLM_API_KEY=… node "${path}" --http-only`)),
    step(2, "Press Connect above, then open AI ▸ Ask AI…"),
    h("h3", {}, "Claude Code or Claude Desktop (MCP)"),
    step(1, "Add the bridge as an MCP server, from a terminal:",
      code(`claude mcp add amino-spine2d -- node "${path}"`),
      h("div", { class: "ai-hint" }, "or in a project's .mcp.json:"),
      code(`{\n  "mcpServers": {\n    "amino-spine2d": { "command": "node", "args": ["${path}"] }\n  }\n}`)),
    step(2, "Press Connect above, and ask Claude to animate the open rig."),
    h("p", { class: "ai-hint" }, "Every edit the AI makes is one undo step, named \"AI: …\" in History."),
  );
  const ok = h("button", { class: "btn primary" }, "Done");
  on(ok, "pointerup", () => modal.close());
  modal.footer.append(h("div", { class: "spacer" }), ok);
}
