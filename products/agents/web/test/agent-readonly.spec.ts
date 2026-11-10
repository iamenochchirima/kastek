import { expect, test, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111";
const agent = { id: "agent-1", name: "Support agent", avatar: "bot", offering: "customer-service", draftRevision: 1, hasUnpublishedChanges: false, latestVersion: "v1" };

async function mockSession(page: Page, permissions: string[]) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/session") {
      return route.fulfill({
        json: {
          account: { id: "member", email: "member@example.test", displayName: "Member" },
          organizations: [{ id: org, name: "Workspace", role: "member", permissions }],
        },
      });
    }
    if (path.endsWith("/agents/summaries")) {
      return route.fulfill({ json: { agents: [agent], nextCursor: null } });
    }
    if (path.endsWith("/assistant")) return route.fulfill({ json: { agent: null } });
    if (path.endsWith("/inbox-alerts")) return route.fulfill({ json: { unread: 0, alerts: [] } });
    if (path.endsWith("/agents")) return route.fulfill({ json: { agents: [agent] } });
    return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
  });
}

test("member without agents.manage sees no create action or configuration sections", async ({ page }) => {
  await mockSession(page, ["members.read", "agents.read", "knowledge.read", "conversations.read", "conversations.manage"]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/app/agents");
  await expect(page.getByRole("heading", { name: "Your agents", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Create agent", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open Support agent" })).toBeVisible();
});

test("granted member sees create and configuration sections", async ({ page }) => {
  await mockSession(page, [
    "members.read", "agents.read", "agents.manage", "knowledge.read",
    "conversations.read", "conversations.manage",
    "channels.manage", "deploy.manage",
  ]);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/app/agents");
  await expect(page.getByRole("button", { name: "Create agent", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Open Support agent" }).click();
  const nav = page.getByRole("navigation", { name: "Agent sections" });
  await expect(nav.getByRole("link", { name: "Capabilities", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Training data", exact: true })).toBeVisible();
  await expect(nav.getByRole("link", { name: "Behaviour", exact: true })).toBeVisible();
});
