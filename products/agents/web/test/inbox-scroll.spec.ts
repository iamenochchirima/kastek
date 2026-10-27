import { expect, test } from "@playwright/test";

test("desktop Inbox panes scroll independently with the composer in view", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const base = { agentId: "agent", agentName: "Support", deploymentId: "dep", versionId: "v", channel: "website", state: "human_owned", assigneeAccountId: "owner", revision: "1", ownershipGeneration: "1", createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z" };
  const conversations = Array.from({ length: 30 }, (_, index) => ({ ...base, id: `c${index}`, customerName: `Customer ${index}` }));
  const messages = Array.from({ length: 40 }, (_, index) => ({ id: `m${index}`, sequence: String(index + 1), authorKind: "visitor", body: `Message ${index}`, createdAt: base.createdAt }));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { account: { id: "owner", email: "staff@example.test", displayName: "Support" }, organizations: [{ id: "org", name: "Workspace", role: "owner" }] } });
    if (path.endsWith("/members")) return route.fulfill({ json: { members: [{ id: "owner", displayName: "Support" }] } });
    if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [{ id: "agent", name: "Support" }], nextCursor: null } });
    if (path.endsWith("/channels")) return route.fulfill({ json: { connections: [] } });
    if (path.endsWith("/enquiries")) return route.fulfill({ json: { enquiries: [] } });
    if (path.endsWith("/inbox")) return route.fulfill({ json: { conversations, nextCursor: null } });
    if (path.endsWith("/inbox/c0")) return route.fulfill({ json: { conversation: conversations[0], messages, nextSequence: "40", earlierBefore: null } });
    return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
  });
  await page.goto("/app/inbox");
  await page.getByRole("button", { name: /^Customer 0 / }).click();
  await expect(page.getByLabel("Reply to customer")).toBeVisible();
  const panes = await page.evaluate(() => {
    const queue = document.querySelector<HTMLElement>(".inbox-list")!;
    const thread = document.querySelector<HTMLElement>(".inbox-message-scroll")!;
    const details = document.querySelector<HTMLElement>(".inbox-context")!;
    const composer = document.querySelector<HTMLElement>(".inbox-thread form")!;
    const queueScrollable = queue.scrollHeight > queue.clientHeight;
    const threadScrollable = thread.scrollHeight > thread.clientHeight;
    queue.scrollTop = 100;
    thread.scrollTop = 100;
    return { queueScrollable, threadScrollable, queueScroll: queue.scrollTop, threadScroll: thread.scrollTop, detailsOverflow: getComputedStyle(details).overflowY, composerBottom: composer.getBoundingClientRect().bottom, viewportHeight: innerHeight };
  });
  expect(panes.queueScrollable).toBe(true);
  expect(panes.threadScrollable).toBe(true);
  expect(panes.queueScroll).toBeGreaterThan(0);
  expect(panes.threadScroll).toBeGreaterThan(0);
  expect(panes.detailsOverflow).toBe("auto");
  expect(panes.composerBottom).toBeLessThanOrEqual(panes.viewportHeight);
});
