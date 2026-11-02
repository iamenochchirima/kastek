import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) for (const width of [1440, 768, 390]) {
  test(`Inbox queue and handoff at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
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
    await page.goto("/app/inbox");
    const item = page.getByRole("button", { name: /^Customer Agent Support/ });
    await expect(item).toBeVisible();
    if (width > 1050) await expect(page.getByRole("heading", { name: "Select a conversation" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`inbox-empty-${theme}-${width}.png`) });
    await item.click();
    await expect(page.getByText("Customer question")).toBeVisible();
    await expect(page.getByRole("region", { name: "Conversation ownership" }).getByText("Waiting for a person")).toBeVisible();
    await expect(page.getByRole("button", { name: "Assign to me" })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`inbox-handoff-${theme}-${width}.png`) });
    await page.getByRole("button", { name: "Assign to me" }).click();
    await page.getByRole("button", { name: "Take over" }).click();
    await expect(page.getByLabel("Reply to customer")).toBeVisible();
    await page.screenshot({ path: test.info().outputPath(`inbox-human-${theme}-${width}.png`) });
    if (width === 1440) {
      await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
      await expect(page.getByLabel("Reply to customer")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({ path: test.info().outputPath(`inbox-text200-${theme}.png`) });
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  });
}
