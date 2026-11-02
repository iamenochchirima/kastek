import { defineConfig } from "@playwright/test";
const baseURL="http://127.0.0.1:3313";
export default defineConfig({
  testDir:"./e2e",testMatch:"growth-oauth.spec.ts",workers:1,reporter:"line",outputDir:".playwright/oauth-results",
  use:{baseURL,serviceWorkers:"block",trace:"retain-on-failure",screenshot:"only-on-failure"},
  webServer:[
    {command:"node e2e/fixtures/growth-agents-api.mjs",url:"http://127.0.0.1:4312/health",env:{GROWTH_AGENTS_FIXTURE_API_PORT:"4312",GROWTH_MIGRATION_FIXTURE:"1",GROWTH_WEB_ORIGIN:baseURL}},
    {command:"node scripts/serve.mjs --hostname 127.0.0.1 --port 3313",url:baseURL,env:{CORE_API_BASE_URL:"http://127.0.0.1:4312",GROWTH_WEB_ORIGIN:baseURL}},
  ],
});
