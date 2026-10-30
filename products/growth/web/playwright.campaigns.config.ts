import { defineConfig } from "@playwright/test";
import migrationConfig from "./playwright.migration.config";
export default defineConfig({
  ...migrationConfig,
  testMatch: "campaigns-design.spec.ts",
  outputDir: ".playwright/campaigns-results",
  webServer: migrationConfig.webServer && Array.isArray(migrationConfig.webServer) ? migrationConfig.webServer.map(server => ({ ...server, env: { ...server.env, GROWTH_CAMPAIGNS_FIXTURE: "1" } })) : migrationConfig.webServer,
});
