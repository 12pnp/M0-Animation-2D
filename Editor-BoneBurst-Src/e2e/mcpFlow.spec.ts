import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * E5's done-when, kept (E5-PLAN step 10): an MCP client over the real bridge's stdio drives the
 * editor in a browser: the figure PSD rigged with `auto_rig`, given `idle_front` with
 * `apply_motion`, checked with `check_preview`, shown, and the motion undone.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const PORT = 57000 + Math.floor(Math.random() * 3000);
let bridge: ChildProcessWithoutNullStreams | null = null;
let home = "";
let nextId = 1;
const waiting = new Map<number, (msg: { result?: Record<string, unknown>; error?: { message: string } }) => void>();

/** One MCP request; its result. */
function mcp(method: string, params?: unknown): Promise<Record<string, unknown>> {
  const id = nextId++;
  return new Promise((done, fail) => {
    waiting.set(id, (m) => (m.error ? fail(new Error(m.error.message)) : done(m.result!)));
    bridge!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`);
  });
}

/** A tool call's answer as the model reads it, refusals thrown. */
async function tool(name: string, args: unknown): Promise<Record<string, any>> {
  const r = await mcp("tools/call", { name, arguments: args }) as { content: { type: string; text?: string }[]; isError?: boolean };
  const text = r.content.find((c) => c.type === "text")!.text!;
  if (r.isError) throw new Error(`${name} refused: ${text}`);
  return JSON.parse(text);
}

const JOINTS = {
  pelvis: [0, 134], neck: [0, 279], head: [0, 378], "hip.left": [-20, 129], "knee.left": [-20, 76], "ankle.left": [-20, 28],
  "hip.right": [20, 129], "knee.right": [20, 76], "ankle.right": [20, 28], "shoulder.left": [-70, 263], "elbow.left": [-70, 211], "wrist.left": [-70, 158],
  "shoulder.right": [70, 263], "elbow.right": [70, 211], "wrist.right": [70, 158],
};

test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "mcpflow-e2e-"));
  bridge = spawn(process.execPath, [join(ROOT, "mcp", "bridge.mjs")], {
    env: { PATH: process.env.PATH ?? "", HOME: home, BONEBURST_BRIDGE_PORT: String(PORT), BONEBURST_KEYFILE: join(home, "keys.json"), BONEBURST_CALL_TIMEOUT: "20000" },
  });
  let buffer = "";
  bridge.stdout.setEncoding("utf8");
  bridge.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const msg = JSON.parse(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      waiting.get(msg.id)?.(msg);
      waiting.delete(msg.id);
    }
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
  if (home) rmSync(home, { recursive: true, force: true });
});

test("over MCP: auto_rig → apply_motion → check_preview on the figure PSD, shown in the editor, undone in one step", async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto(`/?bridge=${PORT}`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.locator("input[type=file]:not([webkitdirectory])").setInputFiles(join(ROOT, "tests", "fixtures", "psd", "figure.psd"));
  await expect(page.locator(".outline .row", { hasText: "arm L" })).toBeVisible();
  await page.locator(".ai-button").click();
  await expect(page.locator(".ai-button")).toHaveAttribute("data-state", "connected");

  // The client's view of the contract: v2, its note, all its tools.
  const init = await mcp("initialize", { protocolVersion: "2025-06-18" }) as { instructions: string };
  expect(init.instructions).toContain("Tool contract version 2 (from 1");
  const contract = JSON.parse(readFileSync(join(ROOT, "src", "agent", "tools.json"), "utf8")) as { tools: { name: string }[] };
  const listed = await mcp("tools/list") as { tools: { name: string }[] };
  expect(listed.tools.map((t) => t.name).sort()).toEqual(contract.tools.map((t) => t.name).sort());

  const rig = await tool("auto_rig", { joints: JOINTS, view: "front" });
  expect(rig.bones).toHaveLength(11);
  expect(rig.ik).toEqual(["shin_left_ik", "shin_right_ik"]);
  const motion = await tool("apply_motion", { motion: "idle_front", animation: "idle" });
  expect(motion.check.matches).toBe(true);
  const check = await tool("check_preview", { animation: "idle" });
  expect(check).toMatchObject({ animation: "idle", matches: true, seam: [] });
  expect(check.frames).toBeGreaterThan(30);
  await tool("show", { animation: "idle", frame: 10 });
  await expect.poll(() => page.evaluate(() => {
    const s = (window as unknown as { boneburst: { session: { animation: { name: string } | null; frame: number } } }).boneburst.session;
    return [s.animation?.name, s.frame];
  })).toEqual(["idle", 10]);
  // The rig's bones are the editor's own: the tree shows them.
  await expect(page.locator(".outline .row", { hasText: "shin_left" }).first()).toBeVisible();

  expect(await tool("undo", {})).toEqual({ undone: ["AI: apply_motion idle_front as idle"] });
  await expect(page.locator(".timeline select").first()).not.toContainText("idle");
});
