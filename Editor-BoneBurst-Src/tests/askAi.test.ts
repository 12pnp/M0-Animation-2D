import { describe, expect, it } from "vitest";
import { ChatClient, ChatFailed, type Message, shortArgs, transcript, userMessage } from "@/ui/agent/chat";

/** Ask AI without the DOM (E5 step 9): the transcript the panel shows, and the bridge client. */

const pic = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "AAA" } };

describe("Ask AI (E5 step 9)", () => {
  it("the transcript: the person's words and pictures, each step with its outcome, the model's words; tool results are not the person's", () => {
    const messages: Message[] = [
      userMessage("Rig it", [{ mediaType: "image/png", data: "AAA" }]),
      { role: "assistant", content: [{ type: "text", text: "Looking first." }, { type: "tool_use", id: "a", name: "render_frame", input: {} }, { type: "tool_use", id: "b", name: "attach", input: { items: [{ bone: "x", layer: "y" }] } }] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "{}" }, pic] },
        { type: "tool_result", tool_use_id: "b", content: "There is no bone \"x\".", is_error: true },
      ] },
      { role: "assistant", content: [{ type: "tool_use", id: "c", name: "get_rig", input: {} }] },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ];
    expect(transcript(messages)).toEqual([
      { kind: "you", text: "Rig it", pictures: [{ mediaType: "image/png", data: "AAA" }] },
      { kind: "ai", text: "Looking first." },
      { kind: "step", name: "render_frame", args: "", outcome: "done", detail: "{}", pictures: [{ mediaType: "image/png", data: "AAA" }] },
      { kind: "step", name: "attach", args: '{"items":[{"bone":"x","layer":"y"}]}', outcome: "refused", detail: 'There is no bone "x".', pictures: [] },
      { kind: "step", name: "get_rig", args: "", outcome: "running", detail: "", pictures: [] },
      { kind: "ai", text: "Done." },
    ]);
    expect(userMessage("hi")).toEqual({ role: "user", content: "hi" });
    expect(shortArgs({ a: "x".repeat(200) }, 20)).toHaveLength(20);
  });

  it("the client: each endpoint, the bridge's refusal as ChatFailed, a bridge not running said so", async () => {
    const seen: { url: string; body?: unknown }[] = [];
    const fake = (answers: Record<string, [number, unknown]>): typeof fetch => (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      seen.push({ url: path, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      const [status, body] = answers[path] ?? [404, { error: "not found" }];
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
    const c = new ChatClient("http://127.0.0.1:1", fake({
      "/agent/status": [200, { editor: true, chat: false, provider: "glm", model: "glm-4.6", vision: false }],
      "/agent/key": [200, { provider: "glm", chat: true, model: "glm-4.6" }],
      "/chat": [500, { error: "The bridge has no GLM_API_KEY" }],
    }));
    expect(await c.status()).toEqual({ bridge: true, editor: true, chat: false, provider: "glm", model: "glm-4.6", vision: false });
    expect(await c.setKey("glm", "k")).toMatchObject({ chat: true });
    expect(seen.at(-1)).toEqual({ url: "/agent/key", body: { provider: "glm", key: "k" } });
    await expect(c.send([userMessage("x")])).rejects.toThrow(new ChatFailed("The bridge has no GLM_API_KEY"));
    const down = new ChatClient("http://127.0.0.1:1", (async () => { throw new TypeError("fetch failed"); }) as typeof fetch);
    expect((await down.status()).bridge).toBe(false);
    await expect(down.send([])).rejects.toThrow(/not running/);
  });
});
