import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

/**
 * The daily driver end to end (E7-PLAN step 6), as the owner works: the figure PSD opened through
 * Open…, rigged and given a motion by an AI over MCP, a key added by hand, exported to Unity; the
 * export opened again, with no notes, and exported again to the same bytes. The export is kept in
 * node_modules/.cache/daily-driver/ for scripts/daily-driver.ts, which has BoneBurst's C# reader
 * and runtime pose it against v2's engine.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const DAILY_DRIVER_OUT = join(ROOT, "node_modules", ".cache", "daily-driver");
const PORT = 55000 + Math.floor(Math.random() * 1000);
let bridge: ChildProcessWithoutNullStreams | null = null;
let home = "";
const waiting = new Map<number, (m: { result?: Record<string, unknown>; error?: { message: string } }) => void>();
let id = 1;

const JOINTS = {
  pelvis: [0, 134], neck: [0, 279], head: [0, 378], "hip.left": [-20, 129], "knee.left": [-20, 76], "ankle.left": [-20, 28],
  "hip.right": [20, 129], "knee.right": [20, 76], "ankle.right": [20, 28], "shoulder.left": [-70, 263], "elbow.left": [-70, 211], "wrist.left": [-70, 158],
  "shoulder.right": [70, 263], "elbow.right": [70, 211], "wrist.right": [70, 158],
};

test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "daily-driver-"));
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
    }
  });
  for (let i = 0; i < 50 && !(await fetch(`http://127.0.0.1:${PORT}/agent/status`).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 100));
});
test.afterAll(() => { bridge?.kill(); if (home) rmSync(home, { recursive: true, force: true }); });

/** A tool call over MCP; its answer, refusals thrown. */
async function tool(name: string, args: unknown): Promise<Record<string, any>> {
  const n = id++;
  const r = await new Promise<{ result?: Record<string, any>; error?: { message: string } }>((done) => {
    waiting.set(n, done);
    bridge!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method: "tools/call", params: { name, arguments: args } })}\n`);
  });
  const res = r.result as { content: { text: string }[]; isError?: boolean };
  if (r.error || res.isError) throw new Error(`${name} refused: ${r.error?.message ?? res.content[0]!.text}`);
  return JSON.parse(res.content[0]!.text);
}

async function menuItem(page: Page, menu: string, item: string): Promise<void> {
  await page.getByRole("button", { name: menu, exact: true }).click();
  await page.getByRole("menuitem", { name: new RegExp(`^${item.replace(/[.…]/g, "\\$&")}`) }).click();
}

/** What an export wrote into the folder the picker gave the n-th time ("Unity1", "Unity2", …). */
const written = (page: Page, folder: string) => page.evaluate(async (f) => {
  const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(f);
  const out: Record<string, number[]> = {};
  for await (const [name, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemFileHandle]> }).entries()) {
    out[name] = Array.from(new Uint8Array(await (await h.getFile()).arrayBuffer()));
  }
  return out;
}, folder);

test("the daily driver: PSD → AI rig and motion → a key by hand → Export to Unity → the export reopened, unchanged", async ({ page }) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    const w = window as unknown as { picks: number; showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> };
    w.picks = 0;
    w.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle(`Unity${++w.picks}`, { create: true });
  });
  await page.goto(`/?bridge=${PORT}`);
  await page.evaluate(async () => {
    localStorage.clear();
    const root = await navigator.storage.getDirectory();
    for (const n of ["Unity1", "Unity2"]) await root.removeEntry(n, { recursive: true }).catch(() => undefined);
    await new Promise((ok) => { const r = indexedDB.deleteDatabase("boneburst-editor"); r.onsuccess = r.onerror = r.onblocked = ok; });
  });
  await page.reload();
  const open = page.locator('input[type=file][accept*=".psd"]');

  // The PSD, through Open….
  await open.setInputFiles(join(ROOT, "tests", "fixtures", "psd", "figure.psd"));
  await expect(page.locator(".outline .row", { hasText: "arm L" })).toBeVisible();

  // The AI rigs it and gives it a motion, over MCP.
  await page.locator(".ai-button").click();
  await expect(page.locator(".ai-button")).toHaveAttribute("data-state", "connected");
  await new Promise<void>((done) => { const n = id++; waiting.set(n, () => done()); bridge!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method: "initialize", params: { protocolVersion: "2025-06-18" } })}\n`); });
  expect((await tool("auto_rig", { joints: JOINTS, view: "front" })).bones).toHaveLength(11);
  expect((await tool("apply_motion", { motion: "idle_front", animation: "idle" })).check.matches).toBe(true);

  // A key by hand: the left shin, frame 5 of idle, K.
  await page.locator(".dv-tab", { hasText: "Rig" }).click();
  await page.locator(".timeline select").first().selectOption("idle");
  await page.locator(".outline .row", { hasText: "shin_left" }).first().click();
  await page.keyboard.press("Home");
  for (let i = 0; i < 5; i++) await page.keyboard.press(".");
  const before = await page.evaluate(() => (window as unknown as { boneburst: { session: { history: { entries: { labels: string[] } } } } }).boneburst.session.history.entries.labels.length);
  await page.keyboard.press("k");
  await expect.poll(() => page.evaluate(() => (window as unknown as { boneburst: { session: { history: { entries: { labels: string[] } } } } }).boneburst.session.history.entries.labels.length)).toBe(before + 1);

  // Export to Unity.
  await menuItem(page, "File", "Export to Unity…");
  await expect(page.locator(".message")).toHaveText(/Exported to Unity/);
  const first = await written(page, "Unity1");
  const names = Object.keys(first).sort();
  expect(names.some((n) => n.endsWith(".json"))).toBe(true);
  expect(names.some((n) => /\.atlas(\.txt)?$/.test(n))).toBe(true);
  expect(names.some((n) => n.endsWith(".png"))).toBe(true);
  // Kept for scripts/daily-driver.ts (the C# side).
  rmSync(DAILY_DRIVER_OUT, { recursive: true, force: true });
  mkdirSync(DAILY_DRIVER_OUT, { recursive: true });
  for (const [n, bytes] of Object.entries(first)) writeFileSync(join(DAILY_DRIVER_OUT, n), Buffer.from(bytes));

  // The export, opened again: no notes; exported again (another folder): the same bytes.
  await open.setInputFiles(names.map((n) => join(DAILY_DRIVER_OUT, n)));
  await expect(page.locator(".message")).toHaveText(/Opened/);
  await expect(page.locator(".issues")).toBeHidden();
  await menuItem(page, "File", "Export to Unity, another folder…");
  await expect(page.locator(".message")).toHaveText(/Exported to Unity/);
  const second = await written(page, "Unity2");
  expect(Object.keys(second).sort()).toEqual(names);
  for (const n of names) expect(Buffer.from(second[n]!).equals(Buffer.from(first[n]!)), `${n} again`).toBe(true);
  expect(errors).toEqual([]);
});
