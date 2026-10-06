import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import contract from "@/agent/tools.json";

/**
 * The repository's MCP setting (E6-PLAN step 6): `.mcp.json` at the root of the repository v2
 * lives in starts v2's bridge, and no other BoneBurst bridge. Skipped when v2 is not inside it.
 */

const ROOT = join(__dirname, "..", "..");
const FILE = join(ROOT, ".mcp.json");
type Server = { command: string; args?: string[]; env?: Record<string, string> };

let proc: ChildProcessWithoutNullStreams | undefined;
let home: string | undefined;
afterAll(() => { proc?.kill(); if (home) rmSync(home, { recursive: true, force: true }); });

describe.skipIf(!existsSync(FILE))("the repository's .mcp.json (E6 step 6)", () => {
  const servers = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as { mcpServers: Record<string, Server> }).mcpServers : {};
  const bridges = Object.entries(servers).filter(([name, s]) => /boneburst/i.test(name) || /bridge\.mjs/.test([s.command, ...(s.args ?? [])].join(" ")));

  it("has one BoneBurst server, boneburst-editor, and it names v2's bridge, not the old editor's", () => {
    expect(bridges.map(([name]) => name)).toEqual(["boneburst-editor"]);
    const line = [bridges[0]![1].command, ...(bridges[0]![1].args ?? [])].join(" ");
    expect(line).toContain("Editor-BoneBurst-Src/mcp/bridge.mjs");
    expect(line).not.toContain("Animation-BoneBurst-Src");
  });

  it("started exactly as written, from a subfolder, it serves the contract's tools", async () => {
    const s = bridges[0]![1];
    home = mkdtempSync(join(tmpdir(), "mcp-config-"));
    const port = 58000 + Math.floor(Math.random() * 3000);
    proc = spawn(s.command, s.args ?? [], {
      // A session may start anywhere in the repository.
      cwd: join(ROOT, "Editor-BoneBurst-Src", "src"),
      env: { ...s.env, PATH: process.env.PATH ?? "", HOME: home, BONEBURST_BRIDGE_PORT: String(port), BONEBURST_KEYFILE: join(home, "keys.json") },
    });
    let buffer = "";
    const replies = new Map<number, (m: Record<string, unknown>) => void>();
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
        const msg = JSON.parse(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        replies.get(msg.id)?.(msg);
      }
    });
    const rpc = (id: number, method: string, params?: unknown) => new Promise<Record<string, unknown>>((done, fail) => {
      replies.set(id, done);
      proc!.once("exit", (code) => fail(new Error(`the server exited (${code})`)));
      proc!.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })}\n`);
    });
    const init = (await rpc(1, "initialize", { protocolVersion: "2025-06-18" })).result as { serverInfo: { name: string } };
    expect(init.serverInfo.name).toBe("boneburst-editor");
    const list = (await rpc(2, "tools/list")).result as { tools: { name: string }[] };
    expect(list.tools.map((t) => t.name)).toEqual(contract.tools.map((t) => t.name));
  });
});
