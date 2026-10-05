import { defineConfig } from "vitest/config";

export default defineConfig({
  // 5185: the Animo-fork editor runs on 5181, and browser storage is per origin.
  server: { port: 5185, strictPort: true },
  build: { target: "es2022", sourcemap: true },
  test: { include: ["tests/**/*.test.ts"] },
});
