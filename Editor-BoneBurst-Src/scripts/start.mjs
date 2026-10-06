#!/usr/bin/env node
// `npm start` (E7-PLAN step 3): the editor without the dev server. No dependencies beyond the
// editor's own: Node 18 or later.
//
//   1. Builds dist/ with Vite when it is missing or older than any source.
//   2. Serves dist/ on http://localhost:5185, the dev server's origin, so preferences, layouts,
//      recovery copies and the Unity folder's permission are the same ones.
//   3. Starts the AI bridge (mcp/bridge.mjs --http-only) when nothing answers on its port, for the
//      AI button and Ask AI; stops it on exit. A Claude Code session may already run one (.mcp.json).
//   4. Opens the browser.
//
// Options: --port <n> (5185), --no-bridge, --no-open, --no-build (serve dist/ as it is).

import { spawn, spawnSync } from "node:child_process";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import http from "node:http";
import { dirname, extname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 5185;
const BRIDGE_PORT = Number(process.env.BONEBURST_BRIDGE_PORT ?? 5191);

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8",
};

/** The newest modification time under `p` (a file or a folder). */
function newest(p) {
  if (!existsSync(p)) return 0;
  const s = statSync(p);
  if (!s.isDirectory()) return s.mtimeMs;
  let t = 0;
  for (const f of readdirSync(p)) t = Math.max(t, newest(join(p, f)));
  return t;
}

/** dist/ is stale when it is missing or older than anything it is built from. */
export function stale() {
  const built = existsSync(join(DIST, "index.html")) ? statSync(join(DIST, "index.html")).mtimeMs : 0;
  const sources = ["src", "public", "index.html", "vite.config.ts", "package-lock.json"].map((p) => newest(join(ROOT, p)));
  return !built || Math.max(...sources) > built;
}

/** The file under dist/ a request path names, or null for anything outside it. */
export function fileFor(urlPath) {
  let path;
  try { path = decodeURIComponent(urlPath.split("?")[0].split("#")[0]); } catch { return null; }
  if (path.includes("\0")) return null;
  const file = normalize(join(DIST, path.endsWith("/") ? `${path}index.html` : path));
  const rel = relative(DIST, file);
  if (rel.startsWith("..") || rel.split(sep).includes("..")) return null;

  return file;
}

function serve() {
  return http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405).end(); return; }
    const file = fileFor(req.url ?? "/");
    if (!file || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404, { "content-type": "text/plain" }).end("Not found"); return; }
    res.writeHead(200, {
      "content-type": TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
      // Assets carry their content's hash in their names: cached for good. The page itself: never.
      "cache-control": relative(DIST, file).startsWith(`assets${sep}`) ? "public, max-age=31536000, immutable" : "no-cache",
    });
    if (req.method === "HEAD") { res.end(); return; }
    createReadStream(file).pipe(res);
  });
}

async function answers(url) {
  try { return (await fetch(url, { signal: AbortSignal.timeout(800) })).ok; } catch { return false; }
}

async function main() {
  if (!flag("--no-build") && stale()) {
    console.log("Building the editor (dist/ is missing or older than its sources)…");
    const b = spawnSync(process.execPath, [join(ROOT, "node_modules", "vite", "bin", "vite.js"), "build", "--logLevel", "warn"], { cwd: ROOT, stdio: "inherit" });
    if (b.status !== 0) { console.error("The build failed; nothing is served."); process.exit(1); }
  }
  if (!existsSync(join(DIST, "index.html"))) { console.error("dist/ has no index.html: run without --no-build."); process.exit(1); }

  const server = serve();
  await new Promise((done) => {
    server.once("error", (err) => {
      if (err.code === "EADDRINUSE") console.error(`Port ${PORT} is taken (is the dev server, npm run dev, running?). Stop it, or use --port.`);
      else console.error(err.message);
      process.exit(1);
    });
    server.listen(PORT, "localhost", done);
  });
  const url = `http://localhost:${PORT}/`;
  console.log(`BoneBurst Editor: ${url}`);

  let bridge = null;
  if (!flag("--no-bridge")) {
    if (await answers(`http://127.0.0.1:${BRIDGE_PORT}/agent/status`)) console.log(`AI bridge: already running on ${BRIDGE_PORT}.`);
    else {
      // The bridge lets in the editor's origin; on another port, that one.
      const origins = `http://localhost:${PORT},http://127.0.0.1:${PORT}`;
      bridge = spawn(process.execPath, [join(ROOT, "mcp", "bridge.mjs"), "--http-only"], { stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, BONEBURST_ORIGINS: process.env.BONEBURST_ORIGINS ?? origins } });
      console.log(`AI bridge: started on ${BRIDGE_PORT}.`);
    }
  }
  const stop = () => { bridge?.kill(); server.close(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  if (!flag("--no-open")) {
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
    spawn(opener, [url], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
  }
  console.log("Ctrl+C stops it.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) void main();
