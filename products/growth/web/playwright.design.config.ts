import { defineConfig } from "@playwright/test";

const baseURL = "http://127.0.0.1:3312";
export default defineConfig({
  testDir: "./e2e", testMatch: "growth-design.spec.ts", workers: 1, fullyParallel: false,
  reporter: "line", outputDir: ".playwright/design-results",
  use: { baseURL, serviceWorkers: "block", reducedMotion: "reduce", trace: "retain-on-failure", screenshot: "only-on-failure" },
  webServer: [
    { command: "node e2e/fixtures/growth-agents-api.mjs", url: "http://127.0.0.1:4311/health", env: { GROWTH_AGENTS_FIXTURE_API_PORT: "4311", GROWTH_MIGRATION_FIXTURE: "1", GROWTH_WEB_ORIGIN: baseURL } },
    { command: "node scripts/serve.mjs --hostname 127.0.0.1 --port 3312", url: baseURL, env: { CORE_API_BASE_URL: "http://127.0.0.1:4311", GROWTH_WEB_ORIGIN: baseURL } },
  ],
});
