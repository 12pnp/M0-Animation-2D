import { h, on } from "@/view/widgets/dom";
import { Modal } from "@/view/widgets/Modal";
import type { AgentBridge, BridgeState } from "@/app/agent/AgentBridge";

/**
 * AI ▸ Connecting AI…, and the connection strip it shares with the AI panel
 * (`AiPanel.ts`): whether the bridge is there and which model it chats with,
 * with the button that connects or disconnects on the spot. A question typed
 * into a window that cannot answer is the failure the strip is for.
 */

/** This checkout's bridge when the dev server knows it (`__BRIDGE_PATH__`,
 *  `vite.config.ts`). */
function bridgePath(): string {
  return typeof __BRIDGE_PATH__ === "string" && __BRIDGE_PATH__ ? __BRIDGE_PATH__ : "<path to Amino-Spine2D-Src>/mcp/amino-bridge.mjs";
}

/** The status, in the parts every home for it shows: the dot's colour, the
 *  sentence that explains it, and the button that changes it. */
function statusParts(bridge: AgentBridge): { dot: HTMLElement; text: HTMLElement; btn: HTMLButtonElement; dispose: () => void } {
  const dot = h("span", { class: "ai-dot" });
  const text = h("span", { class: "ai-status-text" });
  const btn = h("button", { class: "btn" }) as HTMLButtonElement;
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
        if (ask === asked && info && bridge.state === "connected") text.textContent = `Connected. Ask AI is ready: ${info.provider === "glm" ? "GLM" : "Claude"} (${info.model})${info.vision ? "" : ", text only: it cannot see pictures"}.`;
      });
    }
  };
  sync(bridge.state);
  return { dot, text, btn, dispose: bridge.onState((s) => sync(s)) };
}

/** A connection strip: a light, what it means, and the button that changes it. */
export function statusStrip(bridge: AgentBridge, toggle: () => void): { el: HTMLElement; dispose: () => void } {
  const { dot, text, btn, dispose } = statusParts(bridge);
  on(btn, "pointerup", toggle);
  return { el: h("div", { class: "ai-status" }, dot, text, h("div", { class: "spacer" }), btn), dispose };
}

/** Just the dot, for a panel header: click it for the status as a popup —
 *  the sentence and the connect button, closed by clicking anywhere else. */
export function statusDot(bridge: AgentBridge, toggle: () => void): { el: HTMLElement; dispose: () => void } {
  const { dot, text, btn, dispose } = statusParts(bridge);
  const pop = h("div", { class: "ai-dot-pop" }, text, h("div", { class: "ai-dot-pop-row" }, btn));
  const el = h("button", { class: "ai-dot-btn", title: "Connection status — click for details" }, dot) as HTMLButtonElement;
  const closeAway = (e: Event) => {
    const t = e.target as Node;
    if (!pop.contains(t) && !el.contains(t)) pop.classList.remove("open");
  };
  on(el, "pointerup", () => pop.classList.toggle("open"));
  on(pop, "pointerup", (e) => e.stopPropagation());
  on(btn, "pointerup", () => { toggle(); pop.classList.remove("open"); });
  on(document, "pointerup", closeAway);
  return { el: h("span", { class: "ai-dot-wrap" }, el, pop), dispose };
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
