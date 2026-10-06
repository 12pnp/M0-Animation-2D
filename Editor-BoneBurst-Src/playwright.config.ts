import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests (E4-PLAN step 15): what only a real browser shows, popout windows first. Vite is
 * started on 5185, or the running dev server is used. Chromium only.
 */
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  reporter: [["list"]],
  outputDir: "node_modules/.cache/playwright-results",
  use: { baseURL: "http://localhost:5185", ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
  webServer: { command: "npm run dev", url: "http://localhost:5185", reuseExistingServer: true, timeout: 60_000 },
});
