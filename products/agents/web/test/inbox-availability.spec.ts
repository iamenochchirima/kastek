import { expect, test } from "@playwright/test";

for (const available of [true, false, undefined]) {
  test(`conversation shows current channel availability: ${available}`, async ({ page }) => {
    const id = "33333333-3333-4333-8333-333333333333";
    const conversation = { id, agentId: "agent", agentName: "Support", deploymentId: "deployment", versionId: "version", channel: "website", channelAvailable: available, customerContactId: null, state: "human_owned", assigneeAccountId: "me", revision: "1", ownershipGeneration: "1", createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z" };
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/session") return route.fulfill({ json: { account: { id: "me", email: "staff@example.test", displayName: "Me" }, organizations: [{ id: "org", name: "Workspace", role: "owner" }] } });
      if (path.endsWith("/members")) return route.fulfill({ json: { members: [{ id: "me", displayName: "Me" }], nextCursor: null } });
      if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [{ id: "agent", name: "Support" }], nextCursor: null } });
      if (path.endsWith("/channels")) return route.fulfill({ json: { connections: [] } });
      if (path.endsWith("/enquiries")) return route.fulfill({ json: { enquiries: [] } });
      if (path.endsWith("/inbox")) return route.fulfill({ json: { conversations: [conversation], nextCursor: null } });
      if (path.endsWith(`/inbox/${id}`)) return route.fulfill({ json: { conversation, messages: [], nextSequence: "0", earlierBefore: null } });
      return route.fulfill({ status: 404, json: { error: { message: `Unexpected request ${path}` } } });
    });
    await page.goto(`/app/inbox?conversation=${id}`);
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await expect(page.getByText("Customer record unavailable")).toBeVisible();
    await page.getByRole("button", { name: "Details", exact: true }).click();
    const queue = page.getByRole("complementary", { name: "Customer conversations" });
    if (available === false) await expect(queue.getByText("Channel unavailable", { exact: true })).toBeVisible();
    else await expect(queue.getByText("Channel unavailable", { exact: true })).toHaveCount(0);
    await page.getByLabel("Reply to customer").fill("Hello");
    if (available !== false) {
      await expect(page.getByText("Channel unavailable.", { exact: false })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Send reply" })).toBeEnabled();
    } else {
      await expect(page.getByText("Channel unavailable.", { exact: false })).toBeVisible();
      await expect(page.getByRole("button", { name: "Send reply" })).toBeDisabled();
    }
  });
}
