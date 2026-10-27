import { chromium, expect, test } from "@playwright/test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("Inbox remains usable at 200% browser zoom in both themes", async ({ baseURL }, testInfo) => {
  const temporary = await mkdtemp(join(tmpdir(), "agents-inbox-zoom-"));
  const extension = join(temporary, "extension");
  await mkdir(extension);
  await writeFile(join(extension, "manifest.json"), JSON.stringify({ manifest_version: 3, name: "Inbox zoom test", version: "1.0", permissions: ["tabs"], background: { service_worker: "background.js" } }));
  await writeFile(join(extension, "background.js"), "chrome.runtime.onInstalled.addListener(() => {});\n");
  const context = await chromium.launchPersistentContext(join(temporary, "profile"), {
    channel: "chromium", headless: true, viewport: { width: 1440, height: 900 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    let conversation = { id: "conv", agentId: "agent", agentName: "Support", deploymentId: "dep", versionId: "v", channel: "website", state: "handoff_pending", assigneeAccountId: null as string | null, revision: "1", ownershipGeneration: "1", createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z" };
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/session") return route.fulfill({ json: { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: "org", name: "Workspace", role: "owner" }] } });
      if (path.endsWith("/members")) return route.fulfill({ json: { members: [], nextCursor: null } });
      if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [], nextCursor: null } });
      if (path.endsWith("/channels")) return route.fulfill({ json: { connections: [] } });
      if (path.endsWith("/enquiries")) return route.fulfill({ json: { enquiries: [] } });
      if (path.endsWith("/inbox/conv/commands")) { const command = route.request().postDataJSON(); if (command.action === "claim") conversation = { ...conversation, assigneeAccountId: "owner", revision: "2" }; if (command.action === "takeover") conversation = { ...conversation, state: "human_owned", revision: "3" }; return route.fulfill({ json: {} }); }
      if (path.endsWith("/inbox/conv")) return route.fulfill({ json: { conversation, messages: [{ id: "m", sequence: "1", authorKind: "visitor", body: "Customer question", createdAt: conversation.createdAt }], nextSequence: "1", earlierBefore: null } });
      if (path.endsWith("/inbox")) return route.fulfill({ json: { conversations: [conversation], nextCursor: null } });
      return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
    });
    await page.goto(new URL("/app/inbox", baseURL).href);
    const zoom = await worker.evaluate(async (url: string) => {
      const api = (globalThis as any).chrome;
      const tabs = await api.tabs.query({});
      const target = tabs.find((tab: { url?: string }) => tab.url === url);
      await api.tabs.setZoom(target.id, 2);
      return api.tabs.getZoom(target.id);
    }, page.url());
    expect(zoom).toBe(2);
    await expect.poll(() => page.evaluate(() => devicePixelRatio)).toBe(2);
    expect(await page.evaluate(() => innerWidth)).toBe(720);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const row = page.getByRole("button", { name: /^Customer Agent Support/ });
      await expect(row).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`zoom-queue-${theme}.png`) });
      await row.click();
      await expect(page.getByText("Customer question")).toBeVisible();
      const handoff = page.getByRole("region", { name: "Conversation ownership" });
      await expect(handoff).toBeVisible();
      if (theme === "light") {
        await handoff.getByRole("button", { name: "Assign to me" }).click();
        await handoff.getByRole("button", { name: "Take over" }).click();
      }
      await expect(page.getByLabel("Reply to customer")).toBeVisible();
      await page.getByLabel("Reply to customer").fill("Reply draft");
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await page.screenshot({ path: testInfo.outputPath(`zoom-conversation-${theme}.png`) });
      await page.getByRole("button", { name: "Conversations" }).click();
    }
  } finally {
    await context.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
