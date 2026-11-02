import { expect, test } from "@playwright/test";

test("expanded WhatsApp controls scroll independently and leave the reply composer reachable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 800 });
  const time = "2026-10-01T12:00:00Z";
  const conversation = { id: "conv", agentId: "agent", agentName: "Support", deploymentId: null, versionId: "v", channel: "whatsapp", channelAvailable: true, state: "human_owned", assigneeAccountId: "owner", revision: "1", ownershipGeneration: "1", createdAt: time, updatedAt: time };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { account: { id: "owner", email: "owner@example.test", displayName: "Jordan" }, organizations: [{ id: "org", name: "Workspace", role: "owner" }] } });
    if (path.endsWith("/members")) return route.fulfill({ json: { members: [], nextCursor: null } });
    if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [], nextCursor: null } });
    if (path.endsWith("/channels")) return route.fulfill({ json: { connections: [] } });
    if (path.endsWith("/enquiries")) return route.fulfill({ json: { enquiries: [] } });
    if (path.endsWith("/whatsapp/templates")) return route.fulfill({ json: { templates: [{ id: "approved", name: "update", language: "en_US", category: "UTILITY", status: "APPROVED", supported: true, components: [{ type: "BODY", text: "{{1}} {{2}} {{3}} {{4}} {{5}} {{6}} {{7}} {{8}}" }] }], nextCursor: null } });
    if (path.endsWith("/whatsapp/consent")) return route.fulfill({ json: { revision: 0, granted: false, categories: [] } });
    if (path.endsWith("/inbox/conv")) return route.fulfill({ json: { conversation, messages: [{ id: "m", sequence: "1", authorKind: "visitor", body: "Question", createdAt: time }], nextSequence: "1", earlierBefore: null } });
    if (path.endsWith("/inbox")) return route.fulfill({ json: { conversations: [conversation], nextCursor: null } });
    return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
  });
  await page.goto("/app/inbox");
  await page.getByRole("button", { name: /^Customer Agent Support/ }).click();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByLabel("Conversation details").getByText("Jordan", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Details", exact: true }).click();
  await page.getByText("WhatsApp template reply", { exact: true }).click();
  await page.getByLabel("Approved template").selectOption("approved");
  const controls = page.locator(".inbox-channel-controls");
  await expect.poll(() => controls.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.getByLabel("Body value 8").fill("last field");
  await expect(page.getByLabel("Body value 8")).toHaveValue("last field");
  await page.getByLabel("Reply to customer").fill("Draft reply");
  const reply = page.getByRole("button", { name: "Send reply" });
  await expect(reply).toBeEnabled();
  const bounds = await reply.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(800);
  await expect(page.getByLabel("Conversation messages").getByText("Question")).toBeVisible();
});
