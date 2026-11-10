import { expect, test, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111";
const owner = { id: "owner", email: "owner@example.test", displayName: "Owner" };
const member = { id: "member", email: "member@example.test", displayName: "Member" };
const session = { account: owner, organizations: [{ id: org, name: "Workspace", role: "owner" }] };

type MemberRole = "owner" | "admin" | "member";
type Member = { accountId: string; displayName: string; email: string; role: MemberRole; joinedAt: string };
type Invitation = { id: string; email: string; role: MemberRole; invitedByName: string; expiresAt: string; createdAt: string; expired: boolean };

const ownerPermissions = [
  "workspace.manage", "workspace.delete", "workspace.transfer", "billing.manage",
  "members.read", "members.invite", "members.manage", "members.escalate",
  "agents.read", "agents.manage", "agents.delete", "knowledge.read", "knowledge.manage",
  "knowledge.approve", "channels.manage", "deploy.manage", "models.select",
  "credentials.manage", "conversations.read", "conversations.manage", "conversations.assign",
];
const adminPermissions = ownerPermissions.filter((permission) =>
  !["workspace.delete", "workspace.transfer", "billing.manage", "credentials.manage", "members.escalate"].includes(permission));
const roleFrom = (value: unknown): MemberRole =>
  value === "owner" ? "owner" : value === "admin" ? "admin" : "member";

async function mockMembers(page: Page) {
  let members: Member[] = [
    { accountId: owner.id, displayName: owner.displayName, email: owner.email, role: "owner", joinedAt: "2026-01-02T00:00:00Z" },
    { accountId: member.id, displayName: member.displayName, email: member.email, role: "member", joinedAt: "2026-02-03T00:00:00Z" },
  ];
  let invitations: Invitation[] = [
    { id: "invite-1", email: "pending@example.test", role: "member", invitedByName: owner.displayName, expiresAt: "2027-01-01T00:00:00Z", createdAt: "2026-11-01T00:00:00Z", expired: false },
  ];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
    if (path === "/api/session") return route.fulfill({ json: session });
    if (path.endsWith("/members") && method === "GET") {
      return route.fulfill({
        json: { members, canManage: true, role: "owner", permissions: ownerPermissions, grantableRoles: ["owner", "admin", "member"] },
      });
    }
    if (path.endsWith("/invitations") && method === "GET") return route.fulfill({ json: { invitations } });
    if (path.endsWith("/invitations") && method === "POST") {
      const invitation: Invitation = {
        id: `invite-${invitations.length + 2}`,
        email: String(body?.email ?? ""),
        role: roleFrom(body?.role),
        invitedByName: owner.displayName,
        expiresAt: "2027-01-08T00:00:00Z",
        createdAt: new Date().toISOString(),
        expired: false,
      };
      invitations = [invitation, ...invitations];
      return route.fulfill({ status: 201, json: { invitation } });
    }
    if (path.includes("/members/") && method === "PATCH") {
      const id = path.split("/").at(-1)!;
      members = members.map((item) => item.accountId === id ? { ...item, role: roleFrom(body?.role) } : item);
      return route.fulfill({ json: { member: members.find((item) => item.accountId === id) } });
    }
    if (path.includes("/members/") && method === "DELETE") {
      const id = path.split("/").at(-1)!;
      members = members.filter((item) => item.accountId !== id);
      return route.fulfill({ json: { message: "Member removed" } });
    }
    if (path.includes("/invitations/") && method === "DELETE") {
      const id = path.split("/").at(-1)!;
      invitations = invitations.filter((item) => item.id !== id);
      return route.fulfill({ json: { message: "Invitation revoked" } });
    }
    return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
  });
}

for (const width of [1440, 768, 390]) {
  test(`members page manages invitations, roles and removals at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await mockMembers(page);
    await page.goto("/app/settings?section=members");
    await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();
    await expect(page.getByText("member@example.test", { exact: true })).toBeVisible();
    await expect(page.getByText("pending@example.test", { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    await page.getByRole("button", { name: "Invite member", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Email", { exact: true }).fill("new@example.test");
    await dialog.locator("select").selectOption("owner");
    await dialog.getByRole("button", { name: "Send invitation", exact: true }).click();
    await expect(page.getByText("new@example.test", { exact: true })).toBeVisible();
    await expect(page.getByText("Invitation sent", { exact: true })).toBeVisible();

    const memberRow = page.getByRole("listitem").filter({ hasText: "member@example.test" });
    await memberRow.getByLabel("Role for Member").selectOption("owner");
    await expect(memberRow.locator("span").filter({ hasText: "Owner" })).toBeVisible();

    const pendingRow = page.getByRole("listitem").filter({ hasText: "pending@example.test" });
    await pendingRow.getByRole("button", { name: "Revoke", exact: true }).click();
    const confirm = page.getByRole("alertdialog");
    await expect(confirm).toContainText("Revoke invitation?");
    await confirm.getByRole("button", { name: "Revoke", exact: true }).click();
    await expect(page.getByText("pending@example.test", { exact: true })).toHaveCount(0);

    await memberRow.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(confirm).toContainText("Remove Member?");
    await confirm.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByText("member@example.test", { exact: true })).toHaveCount(0);

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`members-${width}.png`), fullPage: true, animations: "disabled" });
  });
}

test("admin manages members but not owners or peers", async ({ page }) => {
  const admin = { id: "admin", email: "admin@example.test", displayName: "Admin" };
  const members: Member[] = [
    { accountId: owner.id, displayName: owner.displayName, email: owner.email, role: "owner", joinedAt: "2026-01-02T00:00:00Z" },
    { accountId: admin.id, displayName: admin.displayName, email: admin.email, role: "admin", joinedAt: "2026-02-03T00:00:00Z" },
    { accountId: member.id, displayName: member.displayName, email: member.email, role: "member", joinedAt: "2026-03-04T00:00:00Z" },
  ];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
    if (path === "/api/session") {
      return route.fulfill({ json: { account: admin, organizations: [{ id: org, name: "Workspace", role: "admin" }] } });
    }
    if (path.endsWith("/members") && method === "GET") {
      return route.fulfill({
        json: { members, canManage: true, role: "admin", permissions: adminPermissions, grantableRoles: ["admin", "member"] },
      });
    }
    if (path.endsWith("/invitations") && method === "GET") return route.fulfill({ json: { invitations: [] } });
    if (path.endsWith("/invitations") && method === "POST") {
      const invitation: Invitation = {
        id: "invite-admin", email: String(body?.email ?? ""), role: roleFrom(body?.role),
        invitedByName: admin.displayName, expiresAt: "2027-01-08T00:00:00Z",
        createdAt: new Date().toISOString(), expired: false,
      };
      return route.fulfill({ status: 201, json: { invitation } });
    }
    return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/app/settings?section=members");
  await expect(page.getByRole("heading", { name: "Members", exact: true })).toBeVisible();

  const ownerRow = page.getByRole("listitem").filter({ hasText: "owner@example.test" });
  const peerRow = page.getByRole("listitem").filter({ hasText: "admin@example.test" });
  const memberRow = page.getByRole("listitem").filter({ hasText: "member@example.test" });
  await expect(ownerRow.locator("select")).toHaveCount(0);
  await expect(peerRow.locator("select")).toHaveCount(0);
  await expect(memberRow.locator("select")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Invite member", exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Invite member", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator("select option")).toHaveText(["Admin", "Member"]);
  await dialog.getByLabel("Email", { exact: true }).fill("new-admin@example.test");
  await dialog.locator("select").selectOption("admin");
  await dialog.getByRole("button", { name: "Send invitation", exact: true }).click();
  await expect(page.getByText("Invitation sent", { exact: true })).toBeVisible();

  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("owner grants a permission override from the members dialog", async ({ page }) => {
  const target = { accountId: "override-target", displayName: "Target", email: "target@example.test" };
  let member: Member = {
    ...target, role: "member", joinedAt: "2026-03-04T00:00:00Z",
    permissions: ["members.read", "agents.read", "knowledge.read", "conversations.read", "conversations.manage"],
    overrides: [],
  };
  const requests: Array<{ path: string; body: unknown }> = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : null;
    if (path === "/api/session") {
      return route.fulfill({
        json: {
          account: owner,
          organizations: [{ id: org, name: "Workspace", role: "owner", permissions: ownerPermissions }],
        },
      });
    }
    if (path.endsWith("/members") && method === "GET") {
      return route.fulfill({
        json: {
          members: [
            { accountId: owner.id, displayName: owner.displayName, email: owner.email, role: "owner", joinedAt: "2026-01-02T00:00:00Z", permissions: ownerPermissions, overrides: [] },
            member,
          ],
          canManage: true,
          role: "owner",
          permissions: ownerPermissions,
          grantableRoles: ["owner", "admin", "member"],
        },
      });
    }
    if (path.endsWith("/invitations") && method === "GET") return route.fulfill({ json: { invitations: [] } });
    if (path.includes("/permissions/") && method === "PUT") {
      const permission = path.split("/").at(-1)!;
      requests.push({ path, body });
      member = {
        ...member,
        permissions: [...new Set([...(member.permissions ?? []), permission])],
        overrides: [{ permission, effect: "grant" }],
      };
      return route.fulfill({ json: { member: { role: member.role, permissions: member.permissions, overrides: member.overrides } } });
    }
    if (path.endsWith("/inbox-alerts")) return route.fulfill({ json: { unread: 0, alerts: [] } });
    return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/app/settings?section=members");
  const row = page.getByRole("listitem").filter({ hasText: "target@example.test" });
  await row.getByRole("button", { name: "Permissions", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Target · Member", { exact: true })).toBeVisible();
  await dialog.getByLabel("Create and configure agents").selectOption("grant");
  await expect(page.getByText("Permission updated", { exact: true })).toBeVisible();
  expect(requests.at(-1)?.path).toContain("/permissions/agents.manage");
  expect(requests.at(-1)?.body).toEqual({ effect: "grant" });
  await expect(dialog.getByText("Allowed now", { exact: true }).first()).toBeVisible();
  await dialog.getByRole("button", { name: "Close", exact: true }).first().click();
});

test("invitation page handles signed-out, accepted and pending states", async ({ page }) => {
  let accepted = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/invitations/invite-token") return route.fulfill({ json: { invitation: { organizationName: "Workspace", email: "m***@example.test", role: "member", expiresAt: "2027-01-01T00:00:00Z", state: accepted ? "accepted" : "pending" } } });
    if (path === "/api/session") return route.fulfill({ status: 401, json: { error: { code: "SIGN_IN_REQUIRED", message: "Sign in" } } });
    if (path === "/api/invitations/invite-token/accept") { accepted = true; return route.fulfill({ json: { organization: { id: org, name: "Workspace", role: "member" } } }); }
    return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/invite/invite-token");
  await expect(page.getByRole("heading", { name: "Join Workspace", exact: true })).toBeVisible();
  await expect(page.getByText("m***@example.test", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in to accept", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("signed-in invite page accepts and a second visit reports the accepted state", async ({ page }) => {
  let accepted = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/invitations/invite-token") return route.fulfill({ json: { invitation: { organizationName: "Workspace", email: "m***@example.test", role: "member", expiresAt: "2027-01-01T00:00:00Z", state: accepted ? "accepted" : "pending" } } });
    if (path === "/api/session") return route.fulfill({ json: { account: member, organizations: [{ id: org, name: "Workspace", role: "member" }] } });
    if (path === "/api/invitations/invite-token/accept") { accepted = true; return route.fulfill({ json: { organization: { id: org, name: "Workspace", role: "member" } } }); }
    if (path === "/api/overview") return route.fulfill({ json: { period: { days: 7 }, counts: { conversations: 0, needsAttention: 0, enquiries: 0, activeAgents: 0 }, conversationActivity: [], needsAttention: [], recentActivity: [], channels: [] } });
    if (path.endsWith("/overview")) return route.fulfill({ json: { period: { days: 7 }, counts: { conversations: 0, needsAttention: 0, enquiries: 0, activeAgents: 0 }, conversationActivity: [], needsAttention: [], recentActivity: [], channels: [] } });
    if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [], nextCursor: null } });
    return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
  });
  await page.goto("/invite/invite-token");
  await expect(page.getByRole("button", { name: "Accept invitation", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Accept invitation", exact: true }).click();
  await page.waitForURL("**/app/overview");
  await page.goto("/invite/invite-token");
  await expect(page.getByText("This invitation was already accepted.", { exact: true })).toBeVisible();
});
