import { defineConfig, devices } from "@playwright/test";

/**
 * The browser tests of the build (E7-PLAN step 3): `npm start`'s server on its own port, building
 * dist/ first when it is stale. The build has no dev hooks; these tests drive it as a user does.
 */
export default defineConfig({
  testDir: "e2e-build",
  timeout: 60_000,
  reporter: [["list"]],
  outputDir: "node_modules/.cache/playwright-build-results",
  use: { baseURL: "http://localhost:5186", ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
  webServer: { command: "node scripts/start.mjs --no-open --no-bridge --port 5186", url: "http://localhost:5186", reuseExistingServer: false, timeout: 180_000 },
});
