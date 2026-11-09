import { expect, test, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111";
const owner = { id: "owner", email: "owner@example.test", displayName: "Owner" };
const member = { id: "member", email: "member@example.test", displayName: "Member" };
const session = { account: owner, organizations: [{ id: org, name: "Workspace", role: "owner" }] };

type Member = { accountId: string; displayName: string; email: string; role: "owner" | "member"; joinedAt: string };
type Invitation = { id: string; email: string; role: "owner" | "member"; invitedByName: string; expiresAt: string; createdAt: string; expired: boolean };

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
    if (path.endsWith("/members") && method === "GET") return route.fulfill({ json: { members, canManage: true } });
    if (path.endsWith("/invitations") && method === "GET") return route.fulfill({ json: { invitations } });
    if (path.endsWith("/invitations") && method === "POST") {
      const invitation: Invitation = {
        id: `invite-${invitations.length + 2}`,
        email: String(body?.email ?? ""),
        role: body?.role === "owner" ? "owner" : "member",
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
      members = members.map((item) => item.accountId === id ? { ...item, role: body?.role === "owner" ? "owner" : "member" } : item);
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
