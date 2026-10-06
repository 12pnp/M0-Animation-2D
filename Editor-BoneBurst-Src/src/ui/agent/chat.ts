/**
 * Ask AI's talk with the bridge (E5-PLAN step 9), without the DOM: the client for the bridge's
 * HTTP side (`fetch` given, so tests pass their own), and the transcript, the conversation as
 * the rows the panel shows. The conversation is the bridge's: Anthropic-shaped messages.
 */

export interface TextBlock { readonly type: "text"; readonly text: string }
export interface ImageBlock { readonly type: "image"; readonly source: { readonly type: "base64"; readonly media_type: string; readonly data: string } }
export interface ToolUseBlock { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown }
export interface ToolResultBlock { readonly type: "tool_result"; readonly tool_use_id: string; readonly content: string | readonly (TextBlock | ImageBlock)[]; readonly is_error?: boolean }
export type Block = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock;
export interface Message { readonly role: "user" | "assistant"; readonly content: string | readonly Block[] }

/** The providers the bridge offers, by its names. */
export const PROVIDERS = [{ id: "anthropic", label: "Claude" }, { id: "glm", label: "GLM" }] as const;

/** A picture as the panel holds it: its type and base64 data. */
export interface Picture { readonly mediaType: string; readonly data: string }

/** A row of the transcript. */
export type Row =
  | { readonly kind: "you"; readonly text: string; readonly pictures: readonly Picture[] }
  | { readonly kind: "ai"; readonly text: string }
  | { readonly kind: "step"; readonly name: string; readonly args: string; readonly outcome: "done" | "refused" | "running"; readonly detail: string; readonly pictures: readonly Picture[] };

/** The person's message: their words, then their pictures. */
export function userMessage(text: string, pictures: readonly Picture[] = []): Message {
  if (!pictures.length) return { role: "user", content: text };
  return { role: "user", content: [...pictures.map((p): ImageBlock => ({ type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } })), { type: "text", text }] };
}

/** A tool's arguments in one short line. */
export function shortArgs(args: unknown, max = 90): string {
  const s = JSON.stringify(args ?? {});
  if (s === "{}") return "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const blocks = (m: Message): readonly Block[] => (typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content);
const pictureOf = (b: ImageBlock): Picture => ({ mediaType: b.source.media_type, data: b.source.data });

/** The conversation as rows: the person's messages, each tool step with its outcome, the model's words. */
export function transcript(messages: readonly Message[]): Row[] {
  const results = new Map<string, ToolResultBlock>();
  for (const m of messages) for (const b of blocks(m)) if (b.type === "tool_result") results.set(b.tool_use_id, b);
  const rows: Row[] = [];
  for (const m of messages) {
    const bs = blocks(m);
    if (m.role === "user") {
      // Tool results are not the person's words: they are shown with their step.
      const text = bs.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("\n");
      const pictures = bs.filter((b): b is ImageBlock => b.type === "image").map(pictureOf);
      if (text || pictures.length) rows.push({ kind: "you", text, pictures });
      continue;
    }
    for (const b of bs) {
      if (b.type === "text" && b.text.trim()) rows.push({ kind: "ai", text: b.text });
      if (b.type !== "tool_use") continue;
      const r = results.get(b.id);
      const parts = r ? (typeof r.content === "string" ? [{ type: "text" as const, text: r.content }] : r.content) : [];
      const detail = parts.filter((p): p is TextBlock => p.type === "text").map((p) => p.text).join("\n");
      rows.push({
        kind: "step", name: b.name, args: shortArgs(b.input), outcome: !r ? "running" : r.is_error ? "refused" : "done",
        detail, pictures: parts.filter((p): p is ImageBlock => p.type === "image").map(pictureOf),
      });
    }
  }
  return rows;
}

export interface BridgeStatus { readonly bridge: boolean; readonly editor: boolean; readonly chat: boolean; readonly provider: string; readonly model: string; readonly vision: boolean }

/** The bridge refused or failed: its message, for the panel to show. */
export class ChatFailed extends Error {}

/** The bridge's HTTP side, for Ask AI. */
export class ChatClient {
  constructor(readonly url: string, private readonly fetcher: typeof fetch = (...a) => fetch(...a)) {}

  private async call<T>(path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetcher(`${this.url}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch {
      throw new ChatFailed("The AI bridge is not running. Start it in the editor's folder with: node mcp/bridge.mjs");
    }
    const out = await res.json().catch(() => ({})) as T & { error?: string };
    if (!res.ok) throw new ChatFailed(out.error ?? `The bridge answered ${res.status}.`);
    return out;
  }

  /** What the bridge is set to; `bridge` false when it does not answer. */
  async status(): Promise<BridgeStatus> {
    try {
      return { bridge: true, ...await this.call<Omit<BridgeStatus, "bridge">>("/agent/status") };
    } catch {
      return { bridge: false, editor: false, chat: false, provider: "", model: "", vision: false };
    }
  }

  models(): Promise<{ provider: string; model: string; models: string[] }> { return this.call("/agent/models"); }
  setKey(provider: string, key: string): Promise<{ provider: string; chat: boolean; model: string }> { return this.call("/agent/key", { provider, key }); }
  setProvider(provider: string): Promise<{ provider: string; chat: boolean; model: string }> { return this.call("/agent/provider", { provider }); }
  setModel(model: string): Promise<{ model: string }> { return this.call("/agent/model", { model }); }

  /** The conversation so far; the model's turns run to the end. */
  send(messages: readonly Message[]): Promise<{ messages: Message[]; text: string }> { return this.call("/chat", { messages }); }
}
