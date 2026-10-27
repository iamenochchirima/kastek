import { expect, test } from "@playwright/test";

test("selection URL and refresh preserve loaded pages and show external changes", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 850 });
  await page.clock.install();
  const org = "11111111-1111-4111-8111-111111111111";
  const first = "33333333-3333-4333-8333-333333333333", second = "44444444-4444-4444-8444-444444444444";
  let externalState = "automation_active";
  const item = (id: string, name: string) => ({ id, agentId: "agent", agentName: "Support", customerName: name, deploymentId: "deployment", versionId: "version", channel: "website", state: externalState, assigneeAccountId: null, revision: "1", ownershipGeneration: "1", createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z" });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === "/api/session") return route.fulfill({ json: { account: { id: "me", email: "me@example.test", displayName: "Me" }, organizations: [{ id: org, name: "Workspace", role: "owner" }] } });
    if (path.endsWith("/members")) return route.fulfill({ json: { members: [] } });
    if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [], nextCursor: null } });
    if (path.endsWith("/channels")) return route.fulfill({ json: { connections: [] } });
    if (path.endsWith("/enquiries")) return route.fulfill({ json: { enquiries: [] } });
    if (path.endsWith("/inbox")) return route.fulfill({ json: url.searchParams.has("state") ? { conversations: [], nextCursor: null } : url.searchParams.has("cursor") ? { conversations: [item(second, "Second customer")], nextCursor: null } : { conversations: [item(first, "First customer")], nextCursor: "next" } });
    if (path.endsWith(`/inbox/${first}`) || path.endsWith(`/inbox/${second}`)) return route.fulfill({ json: { conversation: item(path.endsWith(first) ? first : second, path.endsWith(first) ? "First customer" : "Second customer"), messages: [], nextSequence: "1", earlierBefore: null } });
    return route.fulfill({ status: 404, json: { error: { message: `Unexpected request ${path}` } } });
  });
  await page.goto("/app/inbox?source=overview");
  await page.getByRole("button", { name: "Load more conversations" }).click();
  await expect(page.getByRole("button", { name: /Second customer/ })).toBeVisible();
  externalState = "handoff_pending";
  await page.clock.fastForward(10000);
  await expect(page.getByRole("button", { name: /Second customer/ })).toContainText("Needs a person");
  await expect(page.getByRole("button", { name: /First customer/ })).toContainText("Needs a person");
  await page.getByRole("button", { name: "Refresh" }).click();
  await page.getByRole("button", { name: /Second customer/ }).click();
  await expect(page).toHaveURL(new RegExp(`conversation=${second}`));
  expect(new URL(page.url()).searchParams.get("source")).toBe("overview");
  await page.reload();
  await expect(page.getByRole("heading", { name: "Second customer" })).toBeVisible();
  await page.getByRole("button", { name: "Conversations", exact: true }).click();
  await expect(page).not.toHaveURL(/conversation=/);
  expect(new URL(page.url()).searchParams.get("source")).toBe("overview");
  await page.getByLabel("Filter Inbox status").selectOption("resolved");
  await expect(page.getByText("No matching conversations")).toBeVisible();
});
