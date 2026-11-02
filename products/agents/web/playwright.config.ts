import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  outputDir: ".artifacts/browser",
  timeout: 180_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: process.env.AGENTS_BROWSER_BASE_URL || "http://localhost:3100",
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
