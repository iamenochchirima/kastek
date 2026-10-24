import { defineConfig } from "@playwright/test";

const baseURL = process.env.GROWTH_AGENTS_PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3310";
export default defineConfig({
  testDir: "./e2e", testMatch: "growth-agents.spec.ts", fullyParallel: false, workers: 1,
  reporter: "line", outputDir: ".playwright/agents-results",
  use: { baseURL, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: process.env.GROWTH_AGENTS_PLAYWRIGHT_BASE_URL ? undefined : [
    { command: "node e2e/fixtures/growth-agents-api.mjs", url: "http://127.0.0.1:4310/health", reuseExistingServer: false },
    { command: "node scripts/serve.mjs --hostname 127.0.0.1 --port 3310", url: `${baseURL}/agents`, reuseExistingServer: false, timeout: 120000, env: { CORE_API_BASE_URL: "http://127.0.0.1:4310", GROWTH_WEB_ORIGIN: baseURL } },
  ],
});
