import { defineConfig } from "@playwright/test";
import base from "./playwright.ci.config";

export default defineConfig(base, {
  testMatch: ["chat-workspace.spec.ts", "cited-passages.spec.ts", "tool-reviews.spec.ts", "execution.spec.ts", "customer-channels.spec.ts", "inbox-layout.spec.ts"],
});
