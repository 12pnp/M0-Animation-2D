import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

/**
 * The build, as `npm start` serves it (E7-PLAN step 3), driven as a user drives it: Dockview's
 * styles there; a skeleton opened, keyed and undone through the History panel; the shortcuts
 * sheet; a PSD opened (its reader loads then, not before); the AI button connected and a tool call
 * answered (the AI layer loads then, not before).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const STICKMAN = ["Stickman_IK.json", "Stickman_IK.atlas.txt", "Stickman_IK_tex.png"].map((f) => join(ROOT, "tests", "fixtures", "stickman", f));
const PORT = 56000 + Math.floor(Math.random() * 1000);
let bridge: ChildProcessWithoutNullStreams | null = null;
let home = "";
const waiting = new Map<number, (m: { result?: Record<string, unknown> }) => void>();

test.beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "build-e2e-"));
  bridge = spawn(process.execPath, [join(ROOT, "mcp", "bridge.mjs")], {
    env: { PATH: process.env.PATH ?? "", HOME: home, BONEBURST_BRIDGE_PORT: String(PORT), BONEBURST_KEYFILE: join(home, "keys.json"), BONEBURST_ORIGINS: "http://localhost:5186" },
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

let id = 1;
const mcp = (method: string, params?: unknown) => new Promise<Record<string, unknown>>((done) => {
  const n = id++;
  waiting.set(n, (m) => done(m.result!));
  bridge!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: n, method, ...(params !== undefined ? { params } : {}) })}\n`);
});

test("the build: styles, open, key, undo by History, the sheet, a PSD, the AI layer, each loaded when first used", async ({ page }) => {
  const asked: string[] = [];
  page.on("request", (r) => asked.push(new URL(r.url()).pathname));
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`/?bridge=${PORT}`);
  await page.evaluate(() => localStorage.clear());
  await page.reload();

  // No dev hooks in the build; Dockview's own style rules present.
  expect(await page.evaluate(() => "boneburst" in window)).toBe(false);
  const dvRules = await page.evaluate(() => [...document.styleSheets].flatMap((s) => [...s.cssRules]).filter((r) => (r as CSSStyleRule).selectorText?.includes(".dv-")).length);
  expect(dvRules).toBeGreaterThan(100);
  await expect(page.locator(".dv-tab", { hasText: "History" })).toBeVisible();

  // Open… with the stickman's three files; the run animation; K keys hips; History shows it; ⌘Z.
  await page.locator('input[type=file][accept*=".psd"]').setInputFiles(STICKMAN);
  await expect(page.locator(".outline .row", { hasText: "hips" })).toBeVisible();
  await page.locator(".timeline select").first().selectOption("run");
  await page.locator(".outline .row", { hasText: "hips" }).first().click();
  await page.locator(".dv-tab", { hasText: "History" }).click();
  await page.keyboard.press("k");
  await expect(page.locator(".history-step")).toHaveCount(2);
  await expect(page.locator(".history-step").nth(1)).toHaveAttribute("aria-current", "step");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".history-step").first()).toHaveAttribute("aria-current", "step");

  // The shortcuts sheet.
  await page.keyboard.press("Shift+?");
  await expect(page.getByRole("dialog", { name: "Keyboard Shortcuts" })).toBeVisible();
  await page.getByRole("dialog", { name: "Keyboard Shortcuts" }).getByRole("button", { name: "Close" }).click();

  // Neither lazy part loaded yet.
  expect(asked.filter((p) => /\/assets\/(psd|host)-/.test(p))).toEqual([]);

  // A PSD: its reader loads now.
  await page.locator(".dv-tab", { hasText: "Rig" }).click();
  await page.locator('input[type=file][accept*=".psd"]').setInputFiles(join(ROOT, "tests", "fixtures", "psd", "figure.psd"));
  await expect(page.locator(".outline .row", { hasText: "arm L" })).toBeVisible();
  expect(asked.some((p) => /\/assets\/psd-/.test(p))).toBe(true);

  // The AI button and a tool call: the AI layer loads now.
  await page.locator(".ai-button").click();
  await expect(page.locator(".ai-button")).toHaveAttribute("data-state", "connected");
  await mcp("initialize", { protocolVersion: "2025-06-18" });
  const r = await mcp("tools/call", { name: "get_rig", arguments: {} }) as { content: { text: string }[]; isError?: boolean };
  expect(r.isError).toBeFalsy();
  expect(JSON.parse(r.content[0]!.text).bones.length).toBeGreaterThan(0);
  expect(asked.some((p) => /\/assets\/host-/.test(p))).toBe(true);
  expect(errors).toEqual([]);
});
