import { AgentRefused, type AgentContext } from "@/agent/context";

/**
 * The editor tab's end of `mcp/bridge.mjs` (E5-PLAN step 2), the local process an AI talks to:
 * an MCP client (Claude Code, Claude Desktop) or Ask AI. The tab long-polls the bridge for the
 * next tool call over plain HTTP on 127.0.0.1 (nothing to install in the browser, no key here),
 * runs it through the agent host, and posts the answer back.
 */

export type BridgeState = "off" | "looking" | "connected";

export const DEFAULT_BRIDGE = "http://127.0.0.1:5191";

/** How to start the bridge, for the status line. */
export const START_BRIDGE = "node mcp/bridge.mjs";

interface Call { readonly id: string; readonly name: string; readonly args?: unknown }

/** A tool call the editor is running for an AI (Ask AI shows them live), then its outcome. */
export type CallEvent =
  | { readonly phase: "start"; readonly id: string; readonly name: string; readonly args: unknown }
  | { readonly phase: "end"; readonly id: string; readonly name: string; readonly ok: boolean; readonly detail: string };

export class AiBridge {
  private running = false;
  private now: BridgeState = "off";
  private abort: AbortController | null = null;
  private readonly listeners = new Set<(state: BridgeState, detail: string) => void>();
  private readonly callListeners = new Set<(e: CallEvent) => void>();
  /** Whether the bridge holds an API key, so Ask AI can run. */
  chatReady = false;

  constructor(private readonly ctx: AgentContext, readonly url = DEFAULT_BRIDGE) {}

  get state(): BridgeState { return this.now; }

  onState(f: (state: BridgeState, detail: string) => void): () => void {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  }

  /** Each tool call as it starts and ends. */
  onCall(f: (e: CallEvent) => void): () => void {
    this.callListeners.add(f);
    return () => this.callListeners.delete(f);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.set("looking", "Looking for the AI bridge…");
    void this.loop();
  }

  stop(): void {
    this.running = false;
    this.abort?.abort();
    this.set("off", "Disconnected from the AI bridge.");
  }

  private async loop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      try {
        this.abort = new AbortController();
        // A long poll answers only when a call comes or after 25 s: ask the quick status first,
        // so the button turns green as soon as the bridge is there.
        if (this.now !== "connected") {
          const status = await fetch(`${this.url}/agent/status`, { signal: this.abort.signal });
          if (!status.ok) throw new Error(`status ${status.status}`);
          this.set("connected", "Connected to the AI bridge: an MCP client or Ask AI can work on the open rig.");
        }
        const res = await fetch(`${this.url}/agent/next`, { signal: this.abort.signal });
        this.chatReady = res.headers.get("x-boneburst-chat") === "1";
        if (this.now !== "connected") this.set("connected", "Connected to the AI bridge: an MCP client or Ask AI can work on the open rig.");
        failures = 0;
        if (res.status === 204) continue;
        await this.answer(await res.json() as Call);
      } catch {
        if (!this.running) break;
        failures++;
        this.set("looking", `The AI bridge is not running. Start it in the editor's folder with: ${START_BRIDGE}`);
        await new Promise((r) => setTimeout(r, Math.min(5000, 500 * failures)));
      }
    }
  }

  private async answer(call: Call): Promise<void> {
    let body: Record<string, unknown>;
    const tell = (e: CallEvent) => { for (const f of this.callListeners) f(e); };
    tell({ phase: "start", id: call.id, name: call.name, args: call.args ?? {} });
    try {
      // The AI layer (its tools, the motion clips) loads with the first call (E7-PLAN step 3).
      const { callTool } = await import("@/agent/host");
      body = { id: call.id, ok: true, value: await callTool(call.name, call.args ?? {}, this.ctx) };
      tell({ phase: "end", id: call.id, name: call.name, ok: true, detail: "" });
    } catch (err) {
      // A refusal is the model's to fix; anything else is the editor's failure, said as such.
      const message = err instanceof AgentRefused ? err.message : `The editor failed: ${err instanceof Error ? err.message : String(err)}`;
      body = { id: call.id, ok: false, error: message };
      tell({ phase: "end", id: call.id, name: call.name, ok: false, detail: message });
    }
    await fetch(`${this.url}/agent/result`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  private set(state: BridgeState, detail: string): void {
    if (state === this.now) return;
    this.now = state;
    for (const f of this.listeners) f(state, detail);
  }
}
