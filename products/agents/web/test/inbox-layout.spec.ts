import { expect, test } from "@playwright/test";

for (const { theme, width } of [{ theme: "light", width: 1440 }, { theme: "dark", width: 768 }, { theme: "dark", width: 390 }] as const) {
  test(`Inbox filters and conversation navigation remain usable in ${theme} at ${width}px`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height: 900 });
    const requests: string[] = [];
    const conversation = { id: "conv", agentId: "agent", agentName: "Support agent", deploymentId: "deployment", versionId: "version", channel: "website", state: "handoff_pending", assigneeAccountId: null, revision: "1", ownershipGeneration: "1", createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z" };
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (path === "/api/session") return route.fulfill({ json: { account: { id: "owner", email: "staff@example.test", displayName: "Support" }, organizations: [{ id: "org", name: "Workspace", role: "owner" }] } });
      if (path.endsWith("/members")) return route.fulfill({ json: { members: [] } });
      if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [{ id: "agent", name: "Support agent" }], nextCursor: null } });
      if (path.endsWith("/channels")) return route.fulfill({ json: { connections: [] } });
      if (path.endsWith("/inbox/conv")) return route.fulfill({ json: { conversation, messages: [{ id: "msg", sequence: "1", authorKind: "visitor", body: "Customer question", createdAt: conversation.createdAt }], nextSequence: "1", earlierBefore: null } });
      if (path.endsWith("/inbox")) {
        requests.push(url.search);
        return route.fulfill({ json: { conversations: url.searchParams.get("state") === "resolved" ? [] : [conversation], nextCursor: null } });
      }
      return route.fulfill({ status: 404, json: { error: { message: `Unexpected request ${path}` } } });
    });
    await page.goto("/app/inbox");
    const item = page.getByRole("button", { name: /^Customer Agent Support agent/ });
    await expect(item).toBeVisible();
    await page.getByLabel("Filter Inbox status").selectOption("resolved");
    await expect(page.getByText("No matching conversations")).toBeVisible();
    expect(requests.some(query => new URLSearchParams(query).get("state") === "resolved")).toBe(true);
    await page.getByLabel("Filter Inbox status").selectOption("");
    await item.click();
    await expect(page.getByText("Customer question")).toBeVisible();
    const details = page.getByRole("button", { name: "Details", exact: true });
    await expect(details).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByLabel("Conversation details")).toBeHidden();
    const thread = page.locator(".inbox-thread");
    const threadWidth = await thread.evaluate(element => element.getBoundingClientRect().width);
    expect(threadWidth).toBeGreaterThan(width === 390 ? 250 : 400);
    await details.click();
    await expect(page.getByLabel("Conversation details")).toBeVisible();
    expect(await thread.evaluate(element => element.getBoundingClientRect().width)).toBe(threadWidth);
    await details.press("Escape");
    await expect(page.getByLabel("Conversation details")).toBeHidden();
    await expect(details).toBeFocused();
    if (width <= 1050) {
      await expect(item).toBeHidden();
      const detailWidth = await page.locator(".inbox-conversation-detail").evaluate(element => element.getBoundingClientRect().width);
      expect(detailWidth).toBeGreaterThan(width === 768 ? 400 : 250);
      await page.getByRole("button", { name: "Conversations", exact: true }).click();
      await expect(item).toBeVisible();
      await expect(page.getByLabel("Filter Inbox status")).toBeVisible();
    }
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
