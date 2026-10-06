import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * Ask AI (E5-PLAN step 9): the bridge started on a port of its own (the page told by `?bridge=`) with a fake
 * model; a message typed in the AI panel; the model's tool calls run by the editor on the open
 * rig, shown as steps (a refusal too); its answer, made from what a tool returned, shown.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
let bridge: ChildProcess | null = null;
let model: http.Server | null = null;
let home = "";
const PORT = 53000 + Math.floor(Math.random() * 4000);
const asked: { messages: { role: string; content: unknown }[] }[] = [];

/** The fake model: get_rig, then a call the editor refuses, then words naming how many bones get_rig found. */
function fakeModel(): Promise<number> {
  model = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    asked.push(body);
    const results = body.messages.flatMap((m: { content: unknown }) => (Array.isArray(m.content) ? m.content : [])).filter((b: { type: string }) => b.type === "tool_result");
    res.setHeader("content-type", "application/json");
    if (results.length === 0) return res.end(JSON.stringify({ content: [{ type: "text", text: "Reading the rig." }, { type: "tool_use", id: "t1", name: "get_rig", input: {} }], stop_reason: "tool_use" }));
    if (results.length === 1) return res.end(JSON.stringify({ content: [{ type: "tool_use", id: "t2", name: "attach", input: { items: [{ bone: "nope", layer: "head" }] } }], stop_reason: "tool_use" }));
    // A pause before the answer: the steps show while the model works.
    await new Promise((r) => setTimeout(r, 1500));
    const rig = JSON.parse(typeof results[0].content === "string" ? results[0].content : results[0].content[0].text);
    res.end(JSON.stringify({ content: [{ type: "text", text: `The rig has ${rig.bones.length} bones.` }], stop_reason: "end_turn" }));
  });
  return new Promise((done) => model!.listen(0, "127.0.0.1", () => done((model!.address() as { port: number }).port)));
}

test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "askai-e2e-"));
  const port = await fakeModel();
  bridge = spawn(process.execPath, [join(HERE, "..", "mcp", "bridge.mjs"), "--http-only"], {
    env: {
      PATH: process.env.PATH ?? "", HOME: home, BONEBURST_BRIDGE_PORT: String(PORT),
      BONEBURST_KEYFILE: join(home, "keys.json"), BONEBURST_PROVIDER: "anthropic",
      ANTHROPIC_API_KEY: "test-key", BONEBURST_API_URL: `http://127.0.0.1:${port}/v1/messages`,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let up = false;
  for (let i = 0; i < 50 && !up; i++) {
    up = await fetch(`http://127.0.0.1:${PORT}/agent/status`).then((r) => r.ok, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  if (!up) throw new Error(`The bridge did not start on ${PORT}.`);
});

test.afterAll(() => {
  bridge?.kill();
  model?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

test("Ask AI: a message runs the model's tool calls in the editor, shown as steps, and its answer", async ({ page }) => {
  await page.goto(`/?bridge=${PORT}`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole("button", { name: "Open the stickman fixture" }).click();
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  // The tab's words, not its middle: on a short tab that is its close button.
  await page.locator(".dv-tab", { hasText: /^AI$/ }).getByText("AI", { exact: true }).click();
  const panel = page.locator(".ask-ai");
  await expect(panel.locator(".ai-key")).toBeHidden();

  await panel.getByRole("textbox", { name: "Message to the AI" }).fill("How many bones?");
  await panel.getByRole("textbox", { name: "Message to the AI" }).press("Enter");
  // Sending connected the editor (the tools run through it).
  await expect(page.locator(".ai-button")).toHaveAttribute("data-state", "connected");
  // While the model works, the editor's steps show live.
  await expect(panel.locator(".ai-working")).toBeVisible();
  await expect(panel.locator(".ai-step.ai-refused")).toContainText("attach");
  await expect(panel.locator(".ai-working")).toBeVisible();
  const bones = await page.evaluate(() => (window as unknown as { boneburst: { session: { doc: { bones: unknown[] } } } }).boneburst.session.doc.bones.length);
  await expect(panel.locator(".ai-ai").last()).toHaveText(`The rig has ${bones} bones.`, { timeout: 15_000 });
  await expect(panel.locator(".ai-you")).toHaveText("How many bones?");
  await expect(panel.locator(".ai-step.ai-done")).toHaveText(/✓ get_rig/);
  await expect(panel.locator(".ai-step.ai-refused")).toContainText('There is no bone "nope".');
  // The model was given the editor's tools, and the person's words.
  expect(asked[0]!.messages[0]).toEqual({ role: "user", content: "How many bones?" });

  await panel.getByRole("button", { name: "New chat" }).click();
  await expect(panel.locator(".ai-row")).toHaveCount(0);
});
