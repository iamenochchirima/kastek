import { defineConfig } from "@playwright/test";
import migration from "./playwright.migration.config";

export default defineConfig({
  ...migration,
  testMatch: "contacts-design.spec.ts",
  outputDir: ".playwright/contacts-results",
});
