import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:3412";
export default defineConfig({
  testDir: "./e2e", testMatch: "growth-shared-ui.spec.ts", workers: 1, fullyParallel: false,
  reporter: "line", outputDir: ".playwright/shared-agent-ui-results",
  use: { baseURL, serviceWorkers: "block", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: [
    { command: "node e2e/fixtures/growth-agents-api.mjs", url: "http://127.0.0.1:4412/health", reuseExistingServer: false, env: { GROWTH_AGENTS_FIXTURE_API_PORT: "4412", GROWTH_WEB_ORIGIN: baseURL } },
    { command: "node scripts/serve.mjs --hostname 127.0.0.1 --port 3412", url: `${baseURL}/agents`, reuseExistingServer: false, timeout: 120000, env: { CORE_API_BASE_URL: "http://127.0.0.1:4412", GROWTH_WEB_ORIGIN: baseURL } },
  ],
});
