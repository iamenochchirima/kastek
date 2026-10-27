import { expect, test } from "@playwright/test";

test("owner can search and assign teammates beyond the first page and retry failures", async ({ page }) => {
  const base = { id: "conv", agentId: "agent", agentName: "Support", deploymentId: "dep", versionId: "v", channel: "website", state: "automation_active", assigneeAccountId: null as string | null, revision: "1", ownershipGeneration: "1", createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z" };
  let conversation = { ...base }, pageFailures = 0, searchFailures = 0;
  const actions: { action: string; assigneeAccountId?: string }[] = [];
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === "/api/session") return route.fulfill({ json: { account: { id: "owner", email: "staff@example.test", displayName: "Owner" }, organizations: [{ id: "org", name: "Workspace", role: "owner" }] } });
    if (path.endsWith("/members")) {
      if (!url.searchParams.has("limit")) return route.fulfill({ json: { members: [{ id: "owner", displayName: "Owner" }] } });
      if (url.searchParams.get("search") === "Lerato") {
        if (!searchFailures++) return route.fulfill({ status: 503, json: { error: { message: "Search unavailable" } } });
        return route.fulfill({ json: { members: [{ id: "lerato", displayName: "Lerato" }], nextCursor: null } });
      }
      if (url.searchParams.get("cursor") === "next") {
        if (!pageFailures++) return route.fulfill({ status: 503, json: { error: { message: "Page unavailable" } } });
        return route.fulfill({ json: { members: [{ id: "second", displayName: "Second teammate" }], nextCursor: null } });
      }
      return route.fulfill({ json: { members: [{ id: "first", displayName: "First teammate" }], nextCursor: "next" } });
    }
    if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [], nextCursor: null } });
    if (path.endsWith("/channels")) return route.fulfill({ json: { connections: [] } });
    if (path.endsWith("/enquiries")) return route.fulfill({ json: { enquiries: [] } });
    if (path.endsWith("/inbox/conv/commands")) {
      const command = route.request().postDataJSON(); actions.push(command);
      conversation = { ...conversation, assigneeAccountId: command.assigneeAccountId, revision: String(Number(conversation.revision) + 1) };
      return route.fulfill({ json: {} });
    }
    if (path.endsWith("/inbox/conv")) return route.fulfill({ json: { conversation, messages: [], nextSequence: "0", earlierBefore: null } });
    if (path.endsWith("/inbox")) return route.fulfill({ json: { conversations: [conversation], nextCursor: null } });
    return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
  });
  await page.goto("/app/inbox");
  await page.getByRole("button", { name: /^Customer Agent Support/ }).click();
  await expect(page.getByRole("button", { name: "Assign to me" })).toBeVisible();
  await page.getByText("Assign teammate", { exact: true }).click();
  const picker = page.getByRole("combobox", { name: "Assign conversation" });
  await expect(picker.getByRole("option", { name: "First teammate" })).toHaveCount(1);
  await page.getByRole("button", { name: "More teammates" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(picker.getByRole("option", { name: "Second teammate" })).toHaveCount(1);
  await picker.selectOption("second");
  await page.getByRole("button", { name: "Assign", exact: true }).click();
  await expect.poll(() => actions.length).toBe(1);
  expect(actions[0]).toMatchObject({ action: "assign", assigneeAccountId: "second" });
  await page.getByLabel("Search teammates").fill("Lerato");
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(picker.getByRole("option", { name: "Lerato" })).toHaveCount(1);
  await expect(picker.getByRole("option", { name: "First teammate" })).toHaveCount(0);
});
