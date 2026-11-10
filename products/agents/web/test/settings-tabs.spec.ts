import { expect, test, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111";

const ownerPermissions = [
  "workspace.manage", "workspace.delete", "workspace.transfer", "billing.manage",
  "members.read", "members.invite", "members.manage", "members.escalate",
  "agents.read", "agents.manage", "agents.delete", "knowledge.read", "knowledge.manage",
  "knowledge.approve", "channels.manage", "deploy.manage", "models.select",
  "credentials.manage", "conversations.read", "conversations.manage", "conversations.assign",
];
const adminPermissions = ownerPermissions.filter((permission) =>
  !["workspace.delete", "workspace.transfer", "billing.manage", "credentials.manage", "members.escalate"].includes(permission));

async function mockSession(page: Page, role: "owner" | "admin" | "member") {
  const permissions = role === "owner" ? ownerPermissions : role === "admin" ? adminPermissions : ["members.read", "agents.read", "knowledge.read", "conversations.read", "conversations.manage"];
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") {
      return route.fulfill({
        json: {
          account: { id: role, email: `${role}@example.test`, displayName: role },
          organizations: [{ id: org, name: "Workspace", role, permissions }],
        },
      });
    }
    if (path.endsWith("/inbox-alerts")) return route.fulfill({ json: { unread: 0, alerts: [] } });
    return route.fulfill({ json: { members: [], invitations: [] } });
  });
}

test("owner sees billing, usage and model provider tabs", async ({ page }) => {
  await mockSession(page, "owner");
  await page.goto("/app/settings");
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(nav.getByRole("button", { name: "Billing", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Usage", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Model providers", exact: true })).toBeVisible();
});

test("admin sees members but not billing or model provider tabs", async ({ page }) => {
  await mockSession(page, "admin");
  await page.goto("/app/settings");
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(nav.getByRole("button", { name: "Members", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Billing", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "Usage", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "Model providers", exact: true })).toHaveCount(0);
});

test("member sees only personal and members tabs", async ({ page }) => {
  await mockSession(page, "member");
  await page.goto("/app/settings");
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(nav.getByRole("button", { name: "Account", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Members", exact: true })).toBeVisible();
  await expect(nav.getByRole("button", { name: "Billing", exact: true })).toHaveCount(0);
  await expect(nav.getByRole("button", { name: "Model providers", exact: true })).toHaveCount(0);
});

test("forbidden settings deep link falls back to account", async ({ page }) => {
  await mockSession(page, "admin");
  await page.goto("/app/settings?section=billing");
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Billing", exact: true })).toHaveCount(0);
  expect(new URL(page.url()).searchParams.get("section")).toBe("account");
});
