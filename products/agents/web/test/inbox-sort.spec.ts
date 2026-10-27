import { expect, test } from "@playwright/test";

test("sort changes the server queue and keeps pagination and selected conversation scoped", async ({ page }) => {
  const requests: string[] = [];
  const item = (id: string) => ({ id, agentId: "agent", agentName: "Support", customerName: id, deploymentId: "deployment", versionId: "version", channel: "website", state: "automation_active", assigneeAccountId: null, revision: "1", ownershipGeneration: "1", createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z" });
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url()), path = url.pathname;
    if (path === "/api/session") return route.fulfill({ json: { account: { id: "me", email: "me@example.test", displayName: "Me" }, organizations: [{ id: "org", name: "Workspace", role: "owner" }] } });
    if (path.endsWith("/members")) return route.fulfill({ json: { members: [], nextCursor: null } });
    if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [], nextCursor: null } });
    if (path.endsWith("/channels")) return route.fulfill({ json: { connections: [] } });
    if (path.endsWith("/enquiries")) return route.fulfill({ json: { enquiries: [] } });
    if (path.endsWith("/inbox")) {
      requests.push(url.search);
      const oldest = url.searchParams.get("sort") === "oldest", more = url.searchParams.has("cursor");
      return route.fulfill({ json: { conversations: [item(oldest ? (more ? "Middle" : "Oldest") : "Newest")], nextCursor: oldest && !more ? "oldest-cursor" : null } });
    }
    if (path.endsWith("/inbox/Newest")) return route.fulfill({ json: { conversation: item("Newest"), messages: [], nextSequence: "0", earlierBefore: null } });
    return route.fulfill({ status: 404, json: { error: { message: "Unexpected request" } } });
  });
  await page.goto("/app/inbox");
  await page.getByRole("button", { name: /Newest/ }).click();
  await expect(page.getByRole("heading", { name: "Newest" })).toBeVisible();
  await page.getByLabel("Sort conversations").selectOption("oldest");
  await expect(page.getByRole("button", { name: /Oldest/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Newest" })).toBeVisible();
  await page.getByRole("button", { name: "Load more conversations" }).click();
  await expect(page.getByRole("button", { name: /Middle/ })).toBeVisible();
  expect(requests.some(value => new URLSearchParams(value).get("sort") === "oldest" && new URLSearchParams(value).get("cursor") === "oldest-cursor")).toBe(true);
  await page.getByLabel("Sort conversations").selectOption("newest");
  await expect(page.getByRole("button", { name: /Newest/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Oldest/ })).toHaveCount(0);
});
