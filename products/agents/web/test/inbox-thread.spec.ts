import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) for (const width of [1440, 768, 390]) test(`thread shows real authors and reply composer in ${theme} at ${width}`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: theme });
  const time = "2026-10-01T12:00:00Z";
  const conversation = { id: "conv", agentId: "agent", agentName: "KasiAI", customerName: "Sarah Lim", deploymentId: "dep", versionId: "v", channel: "website", state: "human_owned", assigneeAccountId: "owner", revision: "1", ownershipGeneration: "1", createdAt: time, updatedAt: time };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { account: { id: "owner", email: "owner@example.test", displayName: "Jordan" }, organizations: [{ id: "org", name: "Workspace", role: "owner" }] } });
    if (path.endsWith("/members")) return route.fulfill({ json: { members: [], nextCursor: null } });
    if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [{ id: "agent", name: "KasiAI" }], nextCursor: null } });
    if (path.endsWith("/channels")) return route.fulfill({ json: { connections: [] } });
    if (path.endsWith("/enquiries")) return route.fulfill({ json: { enquiries: [] } });
    if (path.endsWith("/inbox/conv")) return route.fulfill({ json: { conversation, messages: [
      { id: "visitor", sequence: "1", authorKind: "visitor", body: "Can I reschedule?", createdAt: time },
      { id: "assistant", sequence: "2", authorKind: "assistant", body: "How can I help?", createdAt: time },
      { id: "human", sequence: "3", authorKind: "human", authorAccountId: "owner", body: "I can help.", createdAt: time, deliveries: [{ id: "d", segment: 0, state: "sent", reason: null }] },
      { id: "system", sequence: "4", authorKind: "assistant", displayKind: "system", body: "Waiting for support.", createdAt: time },
    ], nextSequence: "3", earlierBefore: null } });
    if (path.endsWith("/inbox")) return route.fulfill({ json: { conversations: [conversation], nextCursor: null } });
    return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
  });
  await page.goto("/app/inbox");
  await page.getByRole("button", { name: /^Sarah Lim/ }).click();
  const log = page.getByRole("log", { name: "Conversation messages" });
  await expect(log.getByText("Sarah Lim", { exact: true })).toBeVisible();
  await expect(log.getByText("KasiAI", { exact: true })).toBeVisible();
  await expect(log.getByText("Jordan", { exact: true })).toBeVisible();
  await expect(log.getByText("System", { exact: true })).toBeVisible();
  await expect(log.getByLabel("Delivery status")).toHaveText("Sent");
  await page.getByLabel("Reply to customer").fill("A draft");
  await expect(page.getByRole("button", { name: "Send reply" })).toBeEnabled();
  await page.screenshot({ path: test.info().outputPath(`inbox-thread-${theme}-${width}.png`) });
});
