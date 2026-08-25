import { defineConfig, devices } from "@playwright/test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const baseURL = process.env.ANALYTICS_PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3100";
const storageState = process.env.ANALYTICS_PLAYWRIGHT_STORAGE_STATE ?? ".playwright/.auth/user.json";
const storageStateFile = resolve(process.cwd(), storageState);
const credentialsConfigured = Boolean(
  process.env.ANALYTICS_PLAYWRIGHT_EMAIL && process.env.ANALYTICS_PLAYWRIGHT_PASSWORD,
);
const authenticatedStorageState = credentialsConfigured || existsSync(storageStateFile) ? storageState : undefined;

const baseUse = {
  ...devices["Desktop Chrome"],
  baseURL,
  trace: "retain-on-failure" as const,
  screenshot: "only-on-failure" as const,
};

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: process.env.CI ? "line" : "list",
  use: {
    ...baseUse,
  },
  projects: [
    {
      name: "anonymous",
      testMatch: "**/analytics.spec.ts",
      use: { ...baseUse, storageState: undefined },
    },
    {
      name: "auth-setup",
      testMatch: "**/auth.setup.ts",
      use: { ...baseUse, storageState: undefined },
    },
    {
      name: "authenticated",
      testMatch: "**/analytics.auth.spec.ts",
      dependencies: ["auth-setup"],
      use: { ...baseUse, storageState: authenticatedStorageState },
    },
  ],
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
