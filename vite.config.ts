import { defineConfig, type Plugin } from "vite";
import { fileURLToPath, URL } from "node:url";
import { readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as { version: string };

export default defineConfig(({ command }) => ({
  // Served from a subdirectory when it is embedded in a site (morenoise.it
  // puts it under /apps/animo/app/); "/" everywhere else, including `npm run
  // dev`. An absolute base and not "./": a relative one resolves against the
  // document URL, and a host that strips the trailing slash would then look
  // for the assets one directory up.
  base: process.env.ANIMO_BASE ?? "/",
  plugins: [noOracleInBuild()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  // The About dialog is the only reader. Injected rather than imported so the
  // bundle does not carry package.json, and so `vitest` (which does not run
  // this config's define) can fall back — see `core/about.ts`.
  // The AI help fills in this checkout's bridge path; `npm run dev` only, so
  // a built copy does not carry the path of the machine that built it.
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __BRIDGE_PATH__: JSON.stringify(command === "serve" ? fileURLToPath(new URL("./mcp/boneburst-bridge.mjs", import.meta.url)) : ""),
  },
  // 5181, not Animo's 5180: storage is per origin, and on one port the two
  // editors would share preferences and overwrite each other's autosave.
  server: { port: 5181, open: false },
  // ES workers can share chunks with the page (the resampler, ag-psd) and
  // load their own imports on demand; the IIFE default cannot split.
  worker: { format: "es" },
  build: {
    target: "es2022",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL("./index.html", import.meta.url)),
        // The preview is a separate document so the vendored runtime keeps
        // the global PIXI it expects, entirely out of the editor bundle.
        preview: fileURLToPath(new URL("./preview.html", import.meta.url)),
      },
    },
  },
}));

/** spine-pixi-v8 is the Preview's oracle, for `npm run dev:oracle` only
 *  (docs/PREVIEW-RUNTIME-PLAN.md, P4): a build does not ship it. */
function noOracleInBuild(): Plugin {
  let outDir = "";
  return {
    name: "no-oracle-in-build",
    apply: "build",
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
    closeBundle() { rmSync(resolve(outDir, "vendor/spine-pixi-v8.js"), { force: true }); },
  };
}
