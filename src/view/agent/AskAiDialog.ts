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
 *  sentence that explains it, the button that changes it, and a short line
 *  for hovering over the dot. */
function statusParts(bridge: AgentBridge, onShort?: (line: string) => void): { dot: HTMLElement; text: HTMLElement; btn: HTMLButtonElement; refresh: () => void; dispose: () => void } {
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
    onShort?.(state === "off" ? "AI bridge: not connected"
      : state === "connecting" ? "AI bridge: looking…"
      : bridge.chatReady ? "Ask AI: ready"
      : "MCP connected — Ask AI needs an API key");
    if (state === "connected" && bridge.chatReady) {
      const ask = ++asked;
      void bridge.info().then((info) => {
        if (ask === asked && info && bridge.state === "connected") {
          const label = `${info.provider === "glm" ? "GLM" : "Claude"} (${info.model})`;
          text.textContent = `Connected. Ask AI is ready: ${label}${info.vision === false ? ", text only: it cannot see pictures" : ""}.`;
          onShort?.(`Ask AI: ${label}${info.vision === false ? ", no pictures" : ""}`);
        }
      });
    }
  };
  sync(bridge.state);
  return { dot, text, btn, refresh: () => sync(bridge.state), dispose: bridge.onState((s) => sync(s)) };
}

/** A connection strip: a light, what it means, and the button that changes it. */
export function statusStrip(bridge: AgentBridge, toggle: () => void): { el: HTMLElement; dispose: () => void } {
  const { dot, text, btn, dispose } = statusParts(bridge);
  on(btn, "pointerup", toggle);
  return { el: h("div", { class: "ai-status" }, dot, text, h("div", { class: "spacer" }), btn), dispose };
}

/** Just the dot, for a panel header: hover it for the status in one short
 *  line, click it for the whole popup — the sentence, the model picker, and
 *  the connect button, closed by clicking anywhere else. */
export function statusDot(bridge: AgentBridge, toggle: () => void): { el: HTMLElement; dispose: () => void } {
  let hover = "AI bridge";
  const el = h("button", { class: "ai-dot-btn", title: hover }) as HTMLButtonElement;
  const { dot, text, btn, refresh, dispose } = statusParts(bridge, (line) => {
    hover = `${line} — click for details`;
    el.title = hover;
  });
  el.appendChild(dot);
  // The model the bridge runs, switchable right here — the bridge holds the
  // key, so the choice is asked of it, never of the page.
  const pick = h("select", { class: "ai-model", title: "The model Ask AI runs, live until the bridge restarts" }) as HTMLSelectElement;
  const modelRow = h("div", { class: "ai-dot-pop-row ai-dot-pop-model" }, h("span", { class: "ai-dot-pop-label" }, "Model"), pick);
  const syncModels = async () => {
    const info = await bridge.models();
    if (!info || info.models.length === 0) { modelRow.style.display = "none"; return; }
    modelRow.style.display = "";
    pick.replaceChildren(...info.models.map((m) => h("option", { value: m }, m)));
    if (!info.models.includes(info.model)) pick.append(new Option(info.model, info.model));
    pick.value = info.model;
  };
  void syncModels();
  on(pick, "change", () => {
    void bridge.setModel(pick.value).then((ok) => { if (ok) { refresh(); void syncModels(); } });
  });

  // A key pasted here goes to the bridge and its key file; the page forgets
  // it the moment the fetch is away.
  const keyInput = h("input", { type: "password", class: "ai-key", placeholder: "Paste a GLM key…", autocomplete: "off" }) as HTMLInputElement;
  const keySave = h("button", { class: "btn" }, "Save") as HTMLButtonElement;
  const saveKey = () => {
    const key = keyInput.value.trim();
    if (!key) return;
    void bridge.setKey("glm", key).then((ok) => {
      keyInput.value = "";
      if (ok) { refresh(); void syncModels(); }
      else keyInput.placeholder = "The bridge refused it — paste it again";
    });
  };
  on(keySave, "pointerup", saveKey);
  on(keyInput, "keydown", (e) => {
    if ((e as unknown as KeyboardEvent).key === "Enter") { e.preventDefault(); saveKey(); }
  });
  const keyRow = h("div", { class: "ai-dot-pop-row ai-dot-pop-key" },
    h("span", { class: "ai-dot-pop-label" }, "GLM key"), keyInput, keySave);

  const pop = h("div", { class: "ai-dot-pop" }, text, modelRow, keyRow, h("div", { class: "ai-dot-pop-row" }, btn));
  const closeAway = (e: Event) => {
    const t = e.target as Node;
    if (!pop.contains(t) && !el.contains(t)) pop.classList.remove("open");
  };
  on(el, "pointerup", () => { pop.classList.toggle("open"); void syncModels(); });
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
      code(`GLM_API_KEY=… node "${path}" --http-only`),
      h("div", { class: "ai-hint" }, "Or skip the terminal: click the ● beside “Ask AI” and paste the key into the popup — the bridge keeps it in its key file (~/.amino-bridge.json, readable only by you) and every later start has it.")),
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
