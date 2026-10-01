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
  /** The constructor-built send, for `ask`. */
  private sender: ((text: string, pictures: Picture[]) => Promise<void>) | null = null;

  constructor(private readonly bridge: AgentBridge, toggleConnection: () => void, close: () => void) {
    const strip = statusStrip(bridge, toggleConnection);
    const log = h("div", { class: "ai-log" });
    const input = h("textarea", { class: "ai-input", placeholder: "Ask the AI to animate the open rig…  (⌘↩ to send)", rows: "4" }) as HTMLTextAreaElement;
    this.input = input;
    const send = h("button", { class: "btn primary ai-send" }, "Send") as HTMLButtonElement;
    const attach = h("button", { class: "btn ai-attach", title: "Attach pictures to the message: a pose or a style to match" }, "📎") as HTMLButtonElement;
    const pending = h("div", { class: "ai-pending" });
    let attached: Picture[] = [];
    const showPending = () => {
      pending.replaceChildren(...attached.map((p, i) => {
        const x = h("button", { class: "ai-pending-x", title: "Remove" }, "×");
        on(x, "pointerup", () => { attached = attached.filter((_, j) => j !== i); showPending(); });
        return h("div", { class: "ai-pending-item" }, thumb(p), x);
      }));
      pending.style.display = attached.length ? "" : "none";
    };
    showPending();
    on(attach, "pointerup", () => pickPictures((pics) => { attached = [...attached, ...pics].slice(0, 6); showPending(); }));
    const reset = h("button", { class: "btn" }, "New conversation") as HTMLButtonElement;
    const closeBtn = h("button", { class: "iconbtn", title: "Hide the AI panel" }, "×");
    on(closeBtn, "pointerup", close);

    this.el = h("div", { class: "ai-panel" },
      h("div", { class: "ai-panel-head" }, h("span", { class: "ai-panel-title" }, "Ask AI"), h("div", { class: "spacer" }), reset, closeBtn),
      h("div", { class: "ai-panel-body" },
        strip.el,
        log,
        pending,
        h("div", { class: "ai-compose" }, input, h("div", { class: "ai-compose-btns" }, send, attach)),
        h("div", { class: "ai-hint" }, "Each edit the AI makes is one undo step, named \"AI: …\" in History.")));

    const say = (who: "you" | "ai" | "note", text: string, pictures: Picture[] = []) => {
      log.querySelector(".ai-empty")?.remove();
      const row = h("div", { class: `ai-msg ai-${who}` },
        who === "note" ? null : h("div", { class: "ai-who" }, who === "you" ? "You" : "AI"),
        text ? h("div", { class: "ai-text" }, text) : null,
        pictures.length ? h("div", { class: "ai-pics" }, ...pictures.map(thumb)) : null);
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
    const send2 = async (text: string, pics: Picture[]): Promise<void> => {
      if ((!text && pics.length === 0) || send.disabled) return;
      const why = problem();
      if (why) { say("note", why); return; }
      say("you", text, pics);
      send.disabled = true;
      const working = say("note", "Working… the stage updates as the AI edits.");
      working.classList.add("ai-working");
      try {
        const content = pics.length
          ? [...pics.map((p) => ({ type: "image", source: { type: "base64", media_type: p.mimeType, data: p.data } })), { type: "text", text: text || "Match this." }]
          : text;
        const before = this.conversation.length + 1;
        const out = await this.bridge.chat([...this.conversation, { role: "user", content }]);
        this.conversation = out.messages;
        working.remove();
        const seen = picturesIn(out.messages.slice(before));
        if (seen.length) say("note", `The AI looked at ${seen.length} picture${seen.length === 1 ? "" : "s"}:`, seen);
        say("ai", out.text || "(done)");
      } catch (err) {
        working.remove();
        say("note", err instanceof Error ? err.message : String(err));
      } finally {
        send.disabled = false;
        input.focus();
      }
    };
    this.sender = send2;
    const go = async () => {
      const text = input.value.trim();
      if ((!text && attached.length === 0) || send.disabled) return;
      const pics = attached;
      input.value = "";
      attached = [];
      showPending();
      await send2(text, pics);
    };
    on(send, "pointerup", () => void go());
    on(input, "keydown", (e) => {
      const k = e as unknown as KeyboardEvent;
      if (k.key === "Enter" && (k.metaKey || k.ctrlKey)) { k.preventDefault(); void go(); }
    });
    on(reset, "pointerup", () => { this.conversation = []; log.replaceChildren(); empty(); input.focus(); });
  }

  focus(): void { this.input.focus(); }

  /** A message composed elsewhere in the editor — the Poses panel's handoff —
   *  sent as if the user typed it. */
  ask(text: string, pictures: Picture[]): void {
    void this.sender?.(text, pictures);
  }
}

/** A picture in the conversation, base64. */
export interface Picture { mimeType: string; data: string }

function thumb(p: Picture): HTMLElement {
  const img = h("img", { class: "ai-pic", src: `data:${p.mimeType};base64,${p.data}`, alt: "" }) as HTMLImageElement;
  on(img, "pointerup", () => window.open(img.src, "_blank"));
  return img;
}

/** The pictures tools returned in these messages (Anthropic's shape). */
function picturesIn(messages: unknown[]): Picture[] {
  const out: Picture[] = [];
  for (const m of messages as Array<{ content?: unknown }>) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content as Array<{ type: string; content?: unknown }>) {
      if (b.type !== "tool_result" || !Array.isArray(b.content)) continue;
      for (const c of b.content as Array<{ type: string; source?: { media_type: string; data: string } }>) {
        if (c.type === "image" && c.source) out.push({ mimeType: c.source.media_type, data: c.source.data });
      }
    }
  }
  return out;
}

/** Pictures from disk, scaled to at most 1024 px on their longer side:
 *  enough for a pose, and a model reads no finer. */
function pickPictures(then: (pictures: Picture[]) => void): void {
  const input = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp,image/gif", multiple: true }) as HTMLInputElement;
  input.style.display = "none";
  document.body.appendChild(input);
  on(input, "change", () => {
    const files = [...(input.files ?? [])];
    input.remove();
    void Promise.all(files.map(async (f) => {
      const bmp = await createImageBitmap(f);
      const s = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
      const canvas = h("canvas") as HTMLCanvasElement;
      canvas.width = Math.max(1, Math.round(bmp.width * s));
      canvas.height = Math.max(1, Math.round(bmp.height * s));
      canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
      const url = canvas.toDataURL("image/png");
      return { mimeType: "image/png", data: url.slice(url.indexOf(",") + 1) };
    })).then(then);
  });
  input.click();
}
