import { h, on } from "@/view/widgets/dom";
import { Modal } from "@/view/widgets/Modal";
import type { AgentBridge } from "@/app/agent/AgentBridge";

/**
 * AI ▸ Ask AI…: a conversation with Claude about the open rig. The bridge
 * process runs the model with the editor's tools (the API key stays there);
 * every edit the model makes is an ordinary undo step, labelled "AI: …".
 * The conversation lasts as long as the page.
 */

let conversation: unknown[] = [];

export function openAskAi(bridge: AgentBridge): void {
  const modal = new Modal({ title: "Ask AI", width: 560, height: 560 });
  const log = h("div", { class: "ai-log" });
  log.style.cssText = "flex:1;overflow:auto;display:flex;flex-direction:column;gap:8px;padding:4px 2px;white-space:pre-wrap;font-size:12px";
  const input = h("textarea", { placeholder: "e.g. Make a 24-frame walk cycle for this rig.", rows: "3" }) as HTMLTextAreaElement;
  input.style.cssText = "width:100%;box-sizing:border-box;resize:vertical;font:inherit";
  const send = h("button", { class: "btn primary" }, "Send") as HTMLButtonElement;
  const reset = h("button", { class: "btn" }, "New conversation") as HTMLButtonElement;
  const status = h("div", { class: "muted" });
  status.style.cssText = "font-size:11px;opacity:.75";
  modal.body.style.cssText = "display:flex;flex-direction:column;gap:8px;height:100%;box-sizing:border-box";
  modal.body.append(log, input, status);
  modal.footer.append(reset, send);

  const say = (who: "you" | "ai" | "note", text: string) => {
    const row = h("div", {}, h("b", {}, who === "you" ? "You: " : who === "ai" ? "AI: " : ""), text);
    if (who === "note") row.style.opacity = ".7";
    log.appendChild(row);
    log.scrollTop = log.scrollHeight;
  };
  for (const m of conversation as Array<{ role: string; content: unknown }>) {
    if (m.role === "user" && typeof m.content === "string") say("you", m.content);
    if (m.role === "assistant" && Array.isArray(m.content)) {
      const text = (m.content as Array<{ type: string; text?: string }>).filter((b) => b.type === "text").map((b) => b.text).join("\n");
      if (text) say("ai", text);
    }
  }
  const ready = () => {
    if (bridge.state !== "connected") return "Not connected: choose AI ▸ Connect to AI, with the bridge running (AI ▸ Connecting Claude…).";
    if (!bridge.chatReady) return "The bridge has no API key: start it with ANTHROPIC_API_KEY set, or use Claude Code over MCP instead.";
    return "";
  };
  status.textContent = ready() || "Each edit the AI makes is one undo step.";

  const go = async () => {
    const text = input.value.trim();
    if (!text || send.disabled) return;
    const problem = ready();
    if (problem) { status.textContent = problem; return; }
    say("you", text);
    input.value = "";
    send.disabled = true;
    status.textContent = "Working… (the stage updates as it edits)";
    try {
      const out = await bridge.chat([...conversation, { role: "user", content: text }]);
      conversation = out.messages;
      say("ai", out.text || "(done)");
      status.textContent = "Each edit the AI makes is one undo step.";
    } catch (err) {
      say("note", err instanceof Error ? err.message : String(err));
      status.textContent = "";
    } finally {
      send.disabled = false;
    }
  };
  on(send, "pointerup", () => void go());
  on(input, "keydown", (e) => {
    const k = e as unknown as KeyboardEvent;
    if (k.key === "Enter" && (k.metaKey || k.ctrlKey)) { k.preventDefault(); void go(); }
  });
  on(reset, "pointerup", () => { conversation = []; log.replaceChildren(); });
  input.focus();
}

/** AI ▸ Connecting Claude…: how to start the bridge and point Claude at it. */
export function openAiHelp(): void {
  const modal = new Modal({ title: "Connecting Claude", width: 600 });
  const pre = (t: string) => {
    const el = h("pre", {}, t);
    el.style.cssText = "background:rgba(127,127,127,.15);padding:8px;border-radius:4px;overflow:auto;font-size:11px;user-select:text";
    return el;
  };
  modal.body.append(
    h("p", {}, "The AI edits this tab through a small local program, the bridge (mcp/amino-bridge.mjs in the source). Nothing leaves your machine except what Claude itself sends."),
    h("p", {}, h("b", {}, "Claude Code or Claude Desktop (MCP). "), "Add the bridge as an MCP server, e.g. in a project's .mcp.json:"),
    pre('{\n  "mcpServers": {\n    "amino-spine2d": { "command": "node", "args": ["<path to>/mcp/amino-bridge.mjs"] }\n  }\n}'),
    h("p", {}, "Then choose AI ▸ Connect to AI here, and ask Claude to animate the open rig."),
    h("p", {}, h("b", {}, "Ask AI, in this window. "), "Run the bridge yourself with an API key, then connect:"),
    pre("ANTHROPIC_API_KEY=sk-ant-… node mcp/amino-bridge.mjs --http-only"),
    h("p", {}, "Every edit the AI makes is one undo step, named \"AI: …\" in History."),
  );
  const ok = h("button", { class: "btn primary" }, "OK");
  on(ok, "pointerup", () => modal.close());
  modal.footer.append(ok);
}
