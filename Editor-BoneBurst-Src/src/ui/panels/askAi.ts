import { type AiBridge, type CallEvent } from "../agent/bridge";
import { ChatClient, ChatFailed, type Message, type Picture, PROVIDERS, type Row, shortArgs, transcript, userMessage } from "../agent/chat";
import { iconButton } from "../icons";
import { empty } from "./outline";

/**
 * The AI panel (E5-PLAN step 9): Ask AI. The person writes what they want (with pictures if they
 * like), the bridge's model does it with the editor's tools, and each tool call shows as the
 * editor runs it. Provider, model and key are the bridge's; the conversation is this panel's.
 */
export class AskAi {
  readonly element: HTMLDivElement;
  private messages: Message[] = [];
  private live: Row[] = [];
  private pictures: Picture[] = [];
  private busy = false;
  private failure: string | null = null;
  private readonly providerSelect = document.createElement("select");
  private readonly modelSelect = document.createElement("select");
  private readonly state = document.createElement("span");
  private readonly keyRow = document.createElement("form");
  private readonly keyInput = document.createElement("input");
  private readonly rows = document.createElement("div");
  private readonly attached = document.createElement("div");
  private readonly input = document.createElement("textarea");
  private readonly sendBtn = document.createElement("button");
  private readonly picker = document.createElement("input");

  /** `connect` turns the editor's AI connection on (the tools run through it). */
  constructor(private readonly client: ChatClient, bridge: AiBridge, private readonly connect: () => void) {
    this.element = document.createElement("div");
    this.element.className = "panel ask-ai";

    const bar = document.createElement("div");
    bar.className = "outline-bar";
    this.providerSelect.title = "Which AI answers (the bridge's providers)";
    for (const p of PROVIDERS) this.providerSelect.append(new Option(p.label, p.id));
    this.providerSelect.addEventListener("change", () => void this.act(() => this.client.setProvider(this.providerSelect.value)));
    this.modelSelect.title = "The model Ask AI runs";
    this.modelSelect.addEventListener("change", () => void this.act(() => this.client.setModel(this.modelSelect.value)));
    const fresh = button("New chat", "Start a new conversation (the rig keeps what was done; Undo takes steps back)", () => {
      this.messages = []; this.live = []; this.failure = null; this.render();
    });
    this.state.className = "ai-state";
    bar.append(this.providerSelect, this.modelSelect, fresh, this.state);

    // The key, when the provider has none: sent to the local bridge, which keeps it.
    this.keyRow.className = "ai-key";
    this.keyInput.type = "password";
    this.keyInput.autocomplete = "off";
    this.keyInput.setAttribute("aria-label", "API key");
    const setKey = document.createElement("button");
    setKey.type = "submit";
    setKey.textContent = "Use key";
    this.keyRow.append(this.keyInput, setKey);
    this.keyRow.addEventListener("submit", (e) => {
      e.preventDefault();
      const key = this.keyInput.value.trim();
      if (!key) return;
      this.keyInput.value = "";
      void this.act(() => this.client.setKey(this.providerSelect.value, key));
    });

    this.rows.className = "ai-rows";
    this.rows.setAttribute("aria-live", "polite");

    const composer = document.createElement("div");
    composer.className = "ai-composer";
    this.attached.className = "ai-attached";
    this.input.placeholder = "Ask the AI to rig or animate… (Enter sends, Shift+Enter for a new line)";
    this.input.rows = 3;
    this.input.setAttribute("aria-label", "Message to the AI");
    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); void this.send(); }
    });
    this.picker.type = "file";
    this.picker.accept = "image/png,image/jpeg,image/webp,image/gif";
    this.picker.multiple = true;
    this.picker.hidden = true;
    this.picker.addEventListener("change", () => {
      const files = [...(this.picker.files ?? [])];
      this.picker.value = "";
      void Promise.all(files.map(readPicture)).then((ps) => { this.pictures.push(...ps); this.render(); });
    });
    const attach = iconButton(button("Attach picture", "Attach pictures: a pose or a style to match", () => this.picker.click()), "addImage", false);
    this.sendBtn.type = "button";
    this.sendBtn.textContent = "Send";
    this.sendBtn.className = "primary";
    this.sendBtn.addEventListener("click", () => void this.send());
    const actions = document.createElement("div");
    actions.className = "ai-actions";
    actions.append(attach, this.sendBtn, this.picker);
    composer.append(this.attached, this.input, actions);

    this.element.append(bar, this.keyRow, this.rows, composer);
    bridge.onCall((e) => this.onCall(e));
    bridge.onState(() => void this.refresh());
    this.render();
    void this.refresh();
  }

  /** The bridge's provider, models and key, read again. */
  async refresh(): Promise<void> {
    const s = await this.client.status();
    this.keyRow.hidden = true;
    if (!s.bridge) {
      this.state.textContent = "The AI bridge is not running: start it with node mcp/bridge.mjs";
      this.providerSelect.disabled = this.modelSelect.disabled = true;
      return;
    }
    this.providerSelect.disabled = this.modelSelect.disabled = false;
    this.providerSelect.value = s.provider;
    const m = await this.client.models().catch(() => ({ models: [s.model], model: s.model }));
    this.modelSelect.replaceChildren(...m.models.map((x) => new Option(x, x)));
    this.modelSelect.value = m.model;
    const label = PROVIDERS.find((p) => p.id === s.provider)?.label ?? s.provider;
    if (!s.chat) {
      this.keyRow.hidden = false;
      this.keyInput.placeholder = `Paste a ${label} API key`;
      this.state.textContent = `No ${label} key yet: paste one (the bridge keeps it on this computer).`;
    } else {
      this.state.textContent = s.vision ? "" : `${s.model} cannot see pictures.`;
    }
  }

  /** A call to the bridge's settings; its failure shown; then read again. */
  private async act(f: () => Promise<unknown>): Promise<void> {
    try { await f(); this.failure = null; } catch (err) { this.failure = err instanceof Error ? err.message : String(err); }
    this.render();
    await this.refresh();
  }

  private async send(): Promise<void> {
    const text = this.input.value.trim();
    if (this.busy || (!text && !this.pictures.length)) return;
    this.connect();
    const asked = [...this.messages, userMessage(text || "(see the pictures)", this.pictures)];
    this.input.value = "";
    this.pictures = [];
    this.messages = asked;
    this.live = [];
    this.failure = null;
    this.busy = true;
    this.render();
    try {
      const out = await this.client.send(asked);
      this.messages = out.messages;
    } catch (err) {
      this.failure = err instanceof ChatFailed || err instanceof Error ? err.message : String(err);
    } finally {
      this.busy = false;
      this.live = [];
      this.render();
      void this.refresh();
    }
  }

  private onCall(e: CallEvent): void {
    if (!this.busy) return;
    if (e.phase === "start") this.live.push({ kind: "step", name: e.name, args: shortArgs(e.args), outcome: "running", detail: "", pictures: [] });
    else {
      let i = this.live.length - 1;
      while (i >= 0 && !(this.live[i]!.kind === "step" && (this.live[i] as Extract<Row, { kind: "step" }>).name === e.name && (this.live[i] as Extract<Row, { kind: "step" }>).outcome === "running")) i--;
      if (i >= 0) this.live[i] = { ...(this.live[i] as Extract<Row, { kind: "step" }>), outcome: e.ok ? "done" : "refused", detail: e.detail };
    }
    this.render();
  }

  private render(): void {
    const rows = [...transcript(this.messages), ...this.live];
    const out: HTMLElement[] = rows.map(rowElement);
    if (!rows.length) out.push(empty("Ask for what you want: “rig this character”, “make a walk”, “wave with the right arm”. The AI works on the open rig; each step is one Undo."));
    if (this.busy) out.push(note("Working…", "ai-working"));
    if (this.failure) out.push(note(this.failure, "ai-failure"));
    this.rows.replaceChildren(...out);
    // To the newest row; again as pictures load and grow the rows.
    const bottom = () => { this.rows.scrollTop = this.rows.scrollHeight; };
    bottom();
    for (const img of this.rows.querySelectorAll("img")) if (!img.complete) img.addEventListener("load", bottom, { once: true });
    this.attached.replaceChildren(...this.pictures.map((p, i) => {
      const img = thumb(p);
      img.title = "Click to remove";
      img.addEventListener("click", () => { this.pictures.splice(i, 1); this.render(); });
      return img;
    }));
    this.sendBtn.disabled = this.busy;
    this.input.disabled = this.busy;
  }
}

function button(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

function note(text: string, cls: string): HTMLParagraphElement {
  const p = document.createElement("p");
  p.className = cls;
  p.textContent = text;
  return p;
}

function thumb(p: Picture): HTMLImageElement {
  const img = document.createElement("img");
  img.className = "ai-thumb";
  img.src = `data:${p.mediaType};base64,${p.data}`;
  img.alt = "picture";
  return img;
}

function rowElement(r: Row): HTMLElement {
  const div = document.createElement("div");
  div.className = `ai-row ai-${r.kind}`;
  if (r.kind === "step") {
    div.classList.add(`ai-${r.outcome}`);
    const head = document.createElement("div");
    head.className = "ai-step-head";
    const mark = r.outcome === "running" ? "…" : r.outcome === "done" ? "✓" : "✗";
    head.textContent = `${mark} ${r.name}${r.args ? ` ${r.args}` : ""}`;
    div.append(head);
    if (r.outcome === "refused" && r.detail) div.append(note(r.detail, "ai-step-detail"));
  } else {
    const p = document.createElement("div");
    p.className = "ai-text";
    p.textContent = r.text;
    div.append(p);
  }
  if (r.kind !== "ai") for (const pic of r.pictures) div.append(thumb(pic));
  return div;
}

async function readPicture(f: File): Promise<Picture> {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { mediaType: f.type || "image/png", data: btoa(bin) };
}
