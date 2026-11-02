import { expect, test } from "@playwright/test";

for (const width of [1440, 390]) test(`keyboard, announcements, long content and key targets at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  const longName = `Customer${"longname".repeat(12)}`, longBody = `Message${"longbody".repeat(120)}`;
  const time = "2026-10-01T12:00:00Z";
  let state = "handoff_pending", assigned: string | null = null, revision = 1, extra = false;
  const conversation = () => ({ id: "conv", agentId: "agent", agentName: "Support", customerName: longName, deploymentId: "dep", versionId: "v", channel: "website", channelAvailable: true, state, assigneeAccountId: assigned, revision: String(revision), ownershipGeneration: "1", createdAt: time, updatedAt: time });
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { account: { id: "owner", email: "owner@example.test", displayName: "Jordan" }, organizations: [{ id: "org", name: "Workspace", role: "owner" }] } });
    if (path.endsWith("/members")) return route.fulfill({ json: { members: [{ id: "owner", displayName: "Jordan" }], nextCursor: null } });
    if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [], nextCursor: null } });
    if (path.endsWith("/channels")) return route.fulfill({ json: { connections: [] } });
    if (path.endsWith("/enquiries")) return route.fulfill({ json: { enquiries: [] } });
    if (path.endsWith("/commands")) { const command = route.request().postDataJSON(); if (command.action === "claim") assigned = "owner"; if (command.action === "takeover") state = "human_owned"; revision++; return route.fulfill({ json: { conversation: conversation() } }); }
    if (path.endsWith("/inbox/conv")) return route.fulfill({ json: { conversation: conversation(), messages: [{ id: "m", sequence: "1", authorKind: "visitor", body: longBody, createdAt: time }, ...(extra ? [{ id: "m2", sequence: "2", authorKind: "visitor", body: "New customer message", createdAt: time }] : [])], nextSequence: "2", earlierBefore: null } });
    if (path.endsWith("/inbox")) return route.fulfill({ json: { conversations: [conversation()], nextCursor: null } });
    return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
  });
  await page.goto("/app/inbox");
  const search = page.getByLabel("Search conversations"), row = page.getByRole("button", { name: new RegExp(`^${longName}`) });
  await expect(row).toBeVisible();
  for (const target of [search, row]) { const box = await target.boundingBox(); expect(box).not.toBeNull(); expect(box!.width).toBeGreaterThanOrEqual(24); expect(box!.height).toBeGreaterThanOrEqual(24); }
  await search.focus(); await page.keyboard.press("Tab"); await expect(row).toBeFocused(); await page.keyboard.press("Enter");
  const log = page.getByRole("log", { name: "Conversation messages" });
  await expect(log).toHaveAttribute("aria-live", "polite");
  await expect(log.getByText(longBody)).toBeVisible();
  const claim = page.getByRole("button", { name: "Assign to me" });
  const claimBox = await claim.boundingBox(); expect(claimBox!.width).toBeGreaterThanOrEqual(24); expect(claimBox!.height).toBeGreaterThanOrEqual(24);
  await claim.focus(); await page.keyboard.press("Enter");
  const takeover = page.getByRole("button", { name: "Take over", exact: true });
  await expect(takeover).toBeEnabled(); const takeoverBox = await takeover.boundingBox(); expect(takeoverBox!.width).toBeGreaterThanOrEqual(24); expect(takeoverBox!.height).toBeGreaterThanOrEqual(24); await takeover.focus(); await page.keyboard.press("Enter");
  const reply = page.getByLabel("Reply to customer"), send = page.getByRole("button", { name: "Send reply" });
  await expect(reply).toBeVisible();
  for (const target of [reply, send]) { const box = await target.boundingBox(); expect(box).not.toBeNull(); expect(box!.width).toBeGreaterThanOrEqual(24); expect(box!.height).toBeGreaterThanOrEqual(24); }
  await reply.focus(); await page.keyboard.type("Keyboard draft"); await expect(send).toBeEnabled();
  extra = true; await expect(log.getByText("New customer message")).toBeVisible({ timeout: 6000 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const pane = page.locator(".inbox-conversation-detail");
  expect(await pane.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
});
