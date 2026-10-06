import { defineConfig, devices } from "@playwright/test";

/**
 * The browser measurement (E9-PLAN): the dev server (its dev hooks attribute the time), Chromium with
 * precise memory figures. By hand: `npx playwright test -c playwright.perf.config.ts`.
 */
export default defineConfig({
  testDir: "e2e-perf",
  timeout: 300_000,
  reporter: [["list"]],
  outputDir: "node_modules/.cache/playwright-perf-results",
  use: {
    baseURL: "http://localhost:5185", ...devices["Desktop Chrome"], viewport: { width: 1600, height: 1000 },
    launchOptions: { args: ["--enable-precise-memory-info", "--js-flags=--expose-gc"] },
  },
  webServer: { command: "npm run dev", url: "http://localhost:5185", reuseExistingServer: true, timeout: 60_000 },
});
