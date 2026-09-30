import { h, on } from "@/view/widgets/dom";
import type { AgentBridge } from "@/app/agent/AgentBridge";
import { statusStrip } from "./AskAiDialog";

/**
 * The AI panel beside the stage (AI ▸ Show AI Panel, the stage bar's AI
 * button): a conversation with Claude or GLM about the open rig. The bridge
 * process runs the model with the editor's tools (the API key stays there);
 * every edit the model makes is an ordinary undo step, labelled "AI: …".
 * A panel rather than a dialog so the stage stays live beside it while the
 * model works. The conversation lasts as long as the page.
 */

const EXAMPLES = [
  "Describe this rig: its bones, IK and animations.",
  "Make a 24-frame walk cycle that loops.",
  "Make a 40-frame idle: slow breathing, a small head bob.",
  "Make a 16-frame hop: the body rises and lands, x moves linearly.",
];

export class AiPanel {
  readonly el: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private conversation: unknown[] = [];

  constructor(private readonly bridge: AgentBridge, toggleConnection: () => void, close: () => void) {
    const strip = statusStrip(bridge, toggleConnection);
    const log = h("div", { class: "ai-log" });
    const input = h("textarea", { class: "ai-input", placeholder: "Ask the AI to animate the open rig…  (⌘↩ to send)", rows: "4" }) as HTMLTextAreaElement;
    this.input = input;
    const send = h("button", { class: "btn primary ai-send" }, "Send") as HTMLButtonElement;
    const reset = h("button", { class: "btn" }, "New conversation") as HTMLButtonElement;
    const closeBtn = h("button", { class: "iconbtn", title: "Hide the AI panel" }, "×");
    on(closeBtn, "pointerup", close);

    this.el = h("div", { class: "ai-panel" },
      h("div", { class: "ai-panel-head" }, h("span", { class: "ai-panel-title" }, "Ask AI"), h("div", { class: "spacer" }), reset, closeBtn),
      h("div", { class: "ai-panel-body" },
        strip.el,
        log,
        h("div", { class: "ai-compose" }, input, send),
        h("div", { class: "ai-hint" }, "Each edit the AI makes is one undo step, named \"AI: …\" in History.")));

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
    empty();

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
        const out = await this.bridge.chat([...this.conversation, { role: "user", content: text }]);
        this.conversation = out.messages;
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
    on(reset, "pointerup", () => { this.conversation = []; log.replaceChildren(); empty(); input.focus(); });
  }

  focus(): void { this.input.focus(); }
}
