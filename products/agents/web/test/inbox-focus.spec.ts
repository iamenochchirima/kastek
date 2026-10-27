import { expect, test, type Page } from "@playwright/test";

async function fixture(page: Page, options: { reject?: boolean; delay?: boolean } = {}) {
  const time = "2026-10-01T12:00:00Z";
  let state = "handoff_pending", assigned: string | null = null, revision = 1;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const conversation = () => ({ id: "conv", agentId: "agent", agentName: "Support", deploymentId: "dep", versionId: "v", channel: "website", channelAvailable: true, state, assigneeAccountId: assigned, revision: String(revision), ownershipGeneration: "1", createdAt: time, updatedAt: time });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { account: { id: "owner", email: "owner@example.test", displayName: "Jordan" }, organizations: [{ id: "org", name: "Workspace", role: "owner" }] } });
    if (path.endsWith("/members")) return route.fulfill({ json: { members: [], nextCursor: null } });
    if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [], nextCursor: null } });
    if (path.endsWith("/channels")) return route.fulfill({ json: { connections: [] } });
    if (path.endsWith("/enquiries")) return route.fulfill({ json: { enquiries: [] } });
    if (path.endsWith("/commands")) {
      const command = route.request().postDataJSON();
      if (options.delay) await gate;
      if (options.reject) return route.fulfill({ status: 409, json: { error: { message: "Action conflict" } } });
      if (command.action === "claim") assigned = "owner";
      if (command.action === "takeover") state = "human_owned";
      if (command.action === "return") state = "automation_active";
      revision++; return route.fulfill({ json: { conversation: conversation() } });
    }
    if (path.endsWith("/inbox/conv")) return route.fulfill({ json: { conversation: conversation(), messages: [], nextSequence: "0", earlierBefore: null } });
    if (path.endsWith("/inbox")) return route.fulfill({ json: { conversations: [conversation()], nextCursor: null } });
    return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
  });
  await page.goto("/app/inbox");
  await page.getByRole("button", { name: /^Customer Agent Support/ }).click();
  return { release, externalClaim: () => { assigned = "owner"; revision++; } };
}

test("keyboard focus follows confirmed claim, takeover and return", async ({ page }) => {
  await fixture(page);
  const claim = page.getByRole("button", { name: "Assign to me" });
  await claim.focus(); await page.keyboard.press("Enter");
  const takeover = page.getByRole("button", { name: "Take over", exact: true });
  await expect(takeover).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Reply to customer")).toBeFocused();
  const returnButton = page.getByRole("button", { name: "Return to automation" });
  await returnButton.focus(); await page.keyboard.press("Enter");
  await expect(takeover).toBeFocused();
});

test("rejected command does not move focus to a different control", async ({ page }) => {
  await fixture(page, { reject: true });
  const claim = page.getByRole("button", { name: "Assign to me" });
  await claim.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("alert")).toContainText("Action conflict");
  await expect(page.getByRole("button", { name: "Take over", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Reply to customer")).toHaveCount(0);
});

test("a user who moves focus during a pending command keeps their new focus", async ({ page }) => {
  const { release } = await fixture(page, { delay: true });
  const claim = page.getByRole("button", { name: "Assign to me" });
  await claim.focus(); await page.keyboard.press("Enter");
  const search = page.getByLabel("Search conversations");
  await search.focus(); release();
  await expect(page.getByRole("button", { name: "Take over", exact: true })).toBeVisible();
  await expect(search).toBeFocused();
});


test("polling another operator's changes does not move focus", async ({ page }) => {
  const { externalClaim } = await fixture(page);
  const search = page.getByLabel("Search conversations");
  await search.focus(); externalClaim();
  await expect(page.getByRole("button", { name: "Take over", exact: true })).toBeVisible({ timeout: 6000 });
  await expect(search).toBeFocused();
});
