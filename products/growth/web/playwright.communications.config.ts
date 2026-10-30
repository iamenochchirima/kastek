import { defineConfig } from "@playwright/test";
import migrationConfig from "./playwright.migration.config";
export default defineConfig({
  ...migrationConfig,
  testMatch: "communications-design.spec.ts",
  outputDir: ".playwright/communications-results",
  webServer: migrationConfig.webServer && Array.isArray(migrationConfig.webServer) ? migrationConfig.webServer.map(server => ({ ...server, env: { ...server.env, GROWTH_COMMUNICATIONS_FIXTURE: "1" } })) : migrationConfig.webServer,
});
