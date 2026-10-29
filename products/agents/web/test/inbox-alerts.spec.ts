import { expect, test } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111";
const conversation = "33333333-3333-4333-8333-333333333333";
for (const theme of ["light", "dark"]) for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`support alerts open the right conversation and acknowledge independently at ${viewport.width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.addInitScript(theme => localStorage.setItem("kasitek-theme", theme), theme);
    let acknowledged = false;
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/session") return route.fulfill({ json: { account: { id: "me", displayName: "Me" }, organizations: [{ id: org, name: "Workspace", role: "owner" }] } });
      if (path.endsWith("/inbox-alerts")) return route.fulfill({ json: { unread: acknowledged ? 0 : 1, alerts: [{ id: "alert", conversationId: conversation, kind: "handoff_requested", createdAt: "2026-10-29T12:00:00Z", acknowledgedAt: acknowledged ? "2026-10-29T12:01:00Z" : null, state: "handoff_pending", assigneeAccountId: null, firstHumanReplyAt: null, href: `/app/inbox?conversation=${conversation}` }] } });
      if (path.endsWith("/alert/acknowledge")) { acknowledged = true; return route.fulfill({ json: { id: "alert", acknowledgedAt: "2026-10-29T12:01:00Z" } }); }
      if (path.endsWith("/inbox")) return route.fulfill({ json: { conversations: [], nextCursor: null } });
      if (path.endsWith(`/inbox/${conversation}`)) return route.fulfill({ json: { conversation: { id: conversation, channel: "website", state: "handoff_pending", assigneeAccountId: null, revision: "1" }, messages: [], earlierBefore: null } });
      if (path.endsWith("/members")) return route.fulfill({ json: { members: [] } });
      if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [], nextCursor: null } });
      if (path.endsWith("/channels")) return route.fulfill({ json: { connections: [] } });
      if (path.endsWith("/enquiries")) return route.fulfill({ json: { enquiries: [] } });
      return route.fulfill({ status: 404, json: { error: { message: "Unavailable" } } });
    });
    await page.goto("/app/inbox");
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    if (viewport.width > 900) await page.getByRole("button", { name: "Collapse sidebar" }).click();
    await page.getByRole("button", { name: "Support alerts, 1 unread", exact: true }).filter({ visible: true }).click();
    const dialog = page.getByRole("dialog", { name: "Support alerts" });
    await expect(dialog.getByText("Human support requested")).toBeVisible();
    await expect(dialog).toHaveCSS("opacity", "1");
    await page.screenshot({ path: `.artifacts/browser/inbox-alerts-${theme}-${viewport.width}.png` });
    await expect(dialog.getByText("Unassigned", { exact: false })).toBeVisible();
    await dialog.getByRole("button", { name: "Mark read" }).click();
    await expect(dialog.getByRole("button", { name: "Mark read" })).toHaveCount(0);
    expect(acknowledged).toBe(true);
    await dialog.getByRole("button", { name: /Open conversation/ }).click();
    await expect(page).toHaveURL(new RegExp(`conversation=${conversation}`));
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
}

test("failed alert acknowledgement preserves the alert and offers retry", async ({ page }) => {
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { account: { id: "me", displayName: "Me" }, organizations: [{ id: org, name: "Workspace", role: "owner" }] } });
    if (path.endsWith("/inbox-alerts")) return route.fulfill({ json: { unread: 1, alerts: [{ id: "alert", conversationId: conversation, kind: "unassigned", createdAt: "2026-10-29T12:00:00Z", acknowledgedAt: null, state: "handoff_pending", assigneeAccountId: null, firstHumanReplyAt: null, href: `/app/inbox?conversation=${conversation}` }] } });
    if (path.endsWith("/acknowledge")) return route.fulfill({ status: 503, json: { error: { message: "Try again later" } } });
    if (path.endsWith("/inbox")) return route.fulfill({ json: { conversations: [], nextCursor: null } });
    return route.fulfill({ json: { members: [], connections: [], agents: [] } });
  });
  await page.goto("/app/inbox");
  await page.getByRole("button", { name: "Support alerts, 1 unread", exact: true }).filter({ visible: true }).click();
  const dialog = page.getByRole("dialog", { name: "Support alerts" });
  await dialog.getByRole("button", { name: /Open conversation/ }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Try again later");
  await expect(dialog.getByRole("button", { name: "Mark read" })).toBeEnabled();
  await expect(page).not.toHaveURL(/conversation=/);
});
