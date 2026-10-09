import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath, URL } from "node:url";
import type { Plugin } from "vite";
import { defineConfig } from "vitest/config";

/**
 * Dockview's own styles as a CSS module, `virtual:dockview.css` (E7-PLAN step 3). Only its UMD
 * build carries them, as the one string it injects on load; the app imports the ES module (half
 * the size) and this. Taken from the pinned package at build time: nothing copied, and a build
 * that finds no such string, or more than one, fails.
 */
function dockviewStyles(): Plugin {
  const id = "virtual:dockview.css", resolved = "\0virtual-dockview.css";
  return {
    name: "dockview-styles",
    resolveId: (source) => (source === id ? resolved : null),
    load(source) {
      if (source !== resolved) return null;
      const umd = readFileSync(createRequire(import.meta.url).resolve("dockview-core/dist/dockview-core.js"), "utf8");
      const found = [...umd.matchAll(/\.textContent = ("(?:[^"\\]|\\.)*");/g)].filter((m) => m[1]!.includes(".dv-"));
      if (found.length !== 1) throw new Error(`dockview-styles: expected one injected style sheet in dockview-core.js, found ${found.length}`);
      return JSON.parse(found[0]![1]!) as string;
    },
  };
}

type ModuleInfoOf = (id: string) => { isEntry: boolean; importers: readonly string[] } | null;

/**
 * `core`: a module of src/model, io, edit or engine that an entry reaches through static imports
 * (CHUNK-SPLIT-PLAN). One reached only through import() (io/psd, edits only the AI tools use) is
 * left to its lazy chunk: a manual chunk would pull it, and what it imports, into the start-up load.
 */
function chunkOf() {
  const pure = /\/src\/(model|io|edit|engine)\//;
  const eager = new Map<string, boolean>();
  const reached = (id: string, info: ModuleInfoOf): boolean => {
    const known = eager.get(id);
    if (known !== undefined) return known;
    eager.set(id, false); // a cycle back here adds nothing
    const m = info(id);
    const result = !!m && (m.isEntry || m.importers.some((i) => reached(i, info)));
    eager.set(id, result);
    return result;
  };
  return (id: string, { getModuleInfo }: { getModuleInfo: ModuleInfoOf }): string | undefined => {
    if (id.includes("/node_modules/dockview-core/")) return "dockview";
    if (pure.test(id) && reached(id, getModuleInfo)) return "core";
    return undefined;
  };
}

export default defineConfig({
  plugins: [dockviewStyles()],
  // 5185: the Animo-fork editor runs on 5181, and browser storage is per origin.
  // Dev only: the samples the format specs' tests use may be opened in the browser (/@fs/…).
  server: { port: 5185, strictPort: true, fs: { allow: [".", "../Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples"] } },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: {
    target: "es2022",
    sourcemap: true,
    // Dockview, the docking shell, in a chunk of its own; the PSD reader and the AI layer are
    // loaded with import() when first used (E7-PLAN step 3); the pure layers the editor loads at
    // start in `core` (CHUNK-SPLIT-PLAN).
    rollupOptions: { output: { manualChunks: chunkOf() } },
  },
  test: { include: ["tests/**/*.test.ts"] },
});
