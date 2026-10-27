import { expect, test } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111";
const conversationId = "33333333-3333-4333-8333-333333333333";

for (const theme of ["light", "dark"] as const) test(`staff can claim, take over, reply and return a conversation in ${theme}`, async ({ page }) => {
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width: theme === "dark" ? 390 : 1440, height: 900 });
  let conversation = { id: conversationId, agentId: "agent", agentName: "Support agent", deploymentId: "deployment", versionId: "version", channel: "website", state: "automation_active", assigneeAccountId: null as string | null, revision: "1", ownershipGeneration: "1", createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z" };
  const commands: { action: string; expectedRevision: string; body?: string }[] = [];
  const messages: { id: string; sequence: string; authorKind: string; body: string; createdAt: string }[] = [];
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { account: { id: "owner", email: "staff@example.test", displayName: "Support" }, organizations: [{ id: org, name: "Workspace", role: "owner" }] } });
    if (path.endsWith("/members")) return route.fulfill({ json: { members: [{ id: "owner", displayName: "Support" }] } });
    if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [{ id: "agent", name: "Support agent" }], nextCursor: null } });
    if (path.endsWith("/channels")) return route.fulfill({ json: { connections: [] } });
    if (path.endsWith("/enquiries")) return route.fulfill({ json: { enquiries: [] } });
    if (path.endsWith("/inbox")) return route.fulfill({ json: { conversations: [conversation], nextCursor: null } });
    if (path.endsWith(`/inbox/${conversationId}/commands`)) {
      const command = route.request().postDataJSON();
      commands.push(command);
      expect(command.expectedRevision).toBe(conversation.revision);
      if (command.action === "claim") conversation = { ...conversation, assigneeAccountId: "owner" };
      if (command.action === "takeover") conversation = { ...conversation, state: "human_owned" };
      if (command.action === "return") conversation = { ...conversation, state: "automation_active" };
      if (command.action === "reply") messages.push({ id: "reply", sequence: "1", authorKind: "human", body: command.body, createdAt: "2026-10-01T12:01:00Z" });
      conversation = { ...conversation, revision: String(Number(conversation.revision) + 1) };
      return route.fulfill({ json: {} });
    }
    if (path.endsWith(`/inbox/${conversationId}`)) return route.fulfill({ json: { conversation, messages, nextSequence: "1", earlierBefore: null } });
    return route.fulfill({ status: 404, json: { error: { message: `Unexpected request ${path}` } } });
  });
  await page.goto("/app/inbox");
  await expect(page.getByRole("button", { name: /^Support agent/ })).toBeVisible();
  const layoutHeight = await page.locator(".inbox-layout").evaluate(element => element.getBoundingClientRect().height);
  expect(layoutHeight).toBeGreaterThanOrEqual(theme === "dark" ? 570 : 700);
  await page.getByRole("button", { name: /^Support agent/ }).click();
  await page.getByRole("button", { name: "Assign to me" }).click();
  await page.getByRole("button", { name: "Take over" }).click();
  await page.getByLabel("Reply to customer").fill("A staff response");
  await page.getByRole("button", { name: "Send reply" }).click();
  await expect(page.getByText("A staff response", { exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
  await page.screenshot({ path: test.info().outputPath(`inbox-takeover-${theme}.png`), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("button", { name: "Return to automation" }).click();
  await expect(page.getByRole("button", { name: "Take over" })).toBeVisible();
  expect(commands.map(command => command.action)).toEqual(["claim", "takeover", "reply", "return"]);
  expect(commands[2].body).toBe("A staff response");
});
