import { defineConfig } from "@playwright/test";
import migrationConfig from "./playwright.migration.config";

export default defineConfig({
  ...migrationConfig,
  testMatch: "growth-design.spec.ts", fullyParallel: false, timeout: 90_000,
  outputDir: ".playwright/design-results",
});
