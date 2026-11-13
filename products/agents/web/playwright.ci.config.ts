import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const baseURL = "http://127.0.0.1:3199";

export default defineConfig(base, {
  testMatch: ["public-entry.spec.ts", "chat-workspace.spec.ts", "model-providers.spec.ts", "model-settings-immediate.spec.ts", "appearance-theme.spec.ts", "assistant.spec.ts"],
  use: { baseURL, serviceWorkers: "block" },
  webServer: {
    command: "pnpm preview --host 127.0.0.1 --port 3199",
    url: baseURL,
    reuseExistingServer: false,
  },
});
