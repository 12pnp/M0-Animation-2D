import { AgentApi, AgentError } from "./AgentApi";

/**
 * The page's end of `mcp/amino-bridge.mjs`, the local process an AI talks
 * to: Claude Code or Claude Desktop over MCP, or the Ask AI dialog through
 * its `/chat`. The page asks the bridge for the next tool call (a long poll,
 * plain HTTP on 127.0.0.1: nothing to install in the browser, no key in the
 * page), runs it through `AgentApi`, and posts the result back.
 */

export type BridgeState = "off" | "connecting" | "connected";

export const DEFAULT_BRIDGE = "http://127.0.0.1:5190";

interface Call { id: string; name: string; args?: Record<string, unknown> }

export class AgentBridge {
  private running = false;
  private stateNow: BridgeState = "off";
  private abort: AbortController | null = null;
  private listeners = new Set<(state: BridgeState, detail: string) => void>();
  /** Whether the bridge holds an API key, so Ask AI can run. */
  chatReady = false;

  constructor(private readonly api: AgentApi, readonly url = DEFAULT_BRIDGE) {}

  get state(): BridgeState { return this.stateNow; }

  onState(fn: (state: BridgeState, detail: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.set("connecting", "Looking for the AI bridge…");
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
    this.set("off", "");
  }

  /** Ask AI: the bridge runs the model and calls back into this page for
   *  every tool it uses. */
  async chat(messages: unknown[]): Promise<{ messages: unknown[]; text: string }> {
    const res = await fetch(`${this.url}/chat`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages }),
    });
    const body = await res.json() as { messages?: unknown[]; text?: string; error?: string };
    if (!res.ok || body.error) throw new Error(body.error ?? `The bridge answered ${res.status}.`);
    return { messages: body.messages ?? [], text: body.text ?? "" };
  }

  /** Which model Ask AI runs, or null when the bridge does not answer. */
  async info(): Promise<{ provider: string; model: string } | null> {
    try {
      const res = await fetch(`${this.url}/agent/status`);
      if (!res.ok) return null;
      const body = await res.json() as { provider?: string; model?: string };
      return { provider: body.provider ?? "anthropic", model: body.model ?? "" };
    } catch {
      return null;
    }
  }

  private async loop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      try {
        this.abort = new AbortController();
        const res = await fetch(`${this.url}/agent/next`, { signal: this.abort.signal });
        this.chatReady = res.headers.get("x-amino-chat") === "1";
        if (this.stateNow !== "connected") this.set("connected", this.chatReady ? "Connected to the AI bridge; Ask AI is ready." : "Connected to the AI bridge.");
        failures = 0;
        if (res.status === 204) continue;
        const call = await res.json() as Call;
        await this.answer(call);
      } catch {
        if (!this.running) break;
        failures++;
        this.set("connecting", "The AI bridge is not running. Start it with: node mcp/amino-bridge.mjs");
        await new Promise((r) => setTimeout(r, Math.min(5000, 500 * failures)));
      }
    }
  }

  private async answer(call: Call): Promise<void> {
    let body: Record<string, unknown>;
    try {
      body = { id: call.id, ok: true, value: await this.api.call(call.name, call.args ?? {}) };
    } catch (err) {
      // A wrong call is the model's to fix; anything else is a bug, said too.
      const message = err instanceof AgentError ? err.message : `The editor failed: ${err instanceof Error ? err.message : String(err)}`;
      body = { id: call.id, ok: false, error: message };
    }
    await fetch(`${this.url}/agent/result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  private set(state: BridgeState, detail: string): void {
    this.stateNow = state;
    for (const fn of this.listeners) fn(state, detail);
  }
}
