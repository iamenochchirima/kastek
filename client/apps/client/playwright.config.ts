import { defineConfig, devices } from "@playwright/test";

const baseURL = process.env.ANALYTICS_PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3100";
const storageState = process.env.ANALYTICS_PLAYWRIGHT_STORAGE_STATE;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  use: {
    ...devices["Desktop Chrome"],
    baseURL,
    storageState: storageState || undefined,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: process.env.ANALYTICS_PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "pnpm exec next start --hostname 127.0.0.1 --port 3100",
        cwd: ".",
        url: `${baseURL}/login`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
