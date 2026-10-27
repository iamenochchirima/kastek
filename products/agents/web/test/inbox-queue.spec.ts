import { expect, test } from "@playwright/test";

for (const { theme, width } of [
  { theme: "light", width: 1440 }, { theme: "dark", width: 1440 },
  { theme: "dark", width: 768 }, { theme: "light", width: 390 }, { theme: "dark", width: 390 },
] as const) {
  test(`queue search and customer identity in ${theme} at ${width}px`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.setViewportSize({ width, height: 900 });
    const base = { agentId: "agent", agentName: "Support agent", deploymentId: "deployment", versionId: "version", channel: "website", state: "automation_active", assigneeAccountId: null, revision: "1", ownershipGeneration: "1", createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z" };
    const known = { ...base, id: "known", customerContactId: "contact", customerName: "Sarah Lim", lastMessage: { body: "Could we reschedule?", authorKind: "visitor", createdAt: base.updatedAt } };
    const anonymous = { ...base, id: "anonymous", customerContactId: null, customerName: null, lastMessage: { body: "[Response unavailable]", authorKind: "assistant", createdAt: base.updatedAt } };
    const searches: string[] = [];
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url()), path = url.pathname;
      if (path === "/api/session") return route.fulfill({ json: { account: { id: "owner", email: "staff@example.test", displayName: "Support" }, organizations: [{ id: "org", name: "Workspace", role: "owner" }] } });
      if (path.endsWith("/members")) return route.fulfill({ json: { members: [] } });
      if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [{ id: "agent", name: "Support agent" }], nextCursor: null } });
      if (path.endsWith("/channels")) return route.fulfill({ json: { connections: [] } });
      if (path.endsWith("/inbox")) {
        const search = url.searchParams.get("search") ?? "";
        searches.push(search);
        return route.fulfill({ json: { conversations: search ? search === "Sarah" ? [known] : [] : [known, anonymous], nextCursor: null } });
      }
      return route.fulfill({ status: 404, json: { error: { message: `Unexpected request ${path}` } } });
    });
    await page.goto("/app/inbox");
    const queue = page.getByRole("complementary", { name: "Customer conversations" });
    await expect(queue.getByText("Sarah Lim")).toBeVisible();
    await expect(queue.getByText("Could we reschedule?")).toBeVisible();
    await expect(queue.getByText("Customer", { exact: true })).toBeVisible();
    await expect(queue.getByText("[Response unavailable]", { exact: true })).toBeVisible();
    if (width > 1050) await expect(page.getByRole("heading", { name: "Select a conversation" })).toBeVisible();
    const search = page.getByRole("textbox", { name: "Search conversations" });
    await search.fill("Sarah");
    await expect.poll(() => searches.includes("Sarah")).toBe(true);
    await expect(queue.getByText("Sarah Lim")).toBeVisible();
    await expect(queue.getByText("Customer", { exact: true })).toHaveCount(0);
    await search.fill("not found");
    await expect(queue.getByText("No matching conversations")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}
