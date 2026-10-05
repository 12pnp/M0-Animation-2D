import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // 5185: the Animo-fork editor runs on 5181, and browser storage is per origin.
  // Dev only: the samples the format specs' tests use may be opened in the browser (/@fs/…).
  server: { port: 5185, strictPort: true, fs: { allow: [".", "../Packages/com.module.ta-creator-boneburst/Tests/Editor/Data~/samples"] } },
  resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
  build: { target: "es2022", sourcemap: true },
  test: { include: ["tests/**/*.test.ts"] },
});
