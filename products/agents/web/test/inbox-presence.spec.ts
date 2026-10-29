import { expect, test } from "@playwright/test";

for (const theme of ["light", "dark"] as const) for (const width of [1440, 390]) {
  test(`staff availability at ${width}px in ${theme}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: theme });
    let state: "unknown" | "available" | "away" = "unknown", fail = false;
    await page.route("**/api/**", async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/session") return route.fulfill({ json: { account: { id: "staff", email: "staff@example.test", displayName: "Staff" }, organizations: [{ id: "org", name: "Workspace", role: "owner" }] } });
      if (path.endsWith("/inbox-presence")) {
        if (route.request().method() === "GET") return route.fulfill({ json: { state, expiresAt: null } });
        if (fail) return route.fulfill({ status: 503, json: { error: { message: "Availability unavailable" } } });
        state = route.request().postDataJSON().state;
        return route.fulfill({ json: { state, leaseId: "00000000-0000-4000-8000-000000000001", expiresAt: "2099-01-01T00:00:00.000Z" } });
      }
      if (path.endsWith("/inbox-presence/renew")) return route.fulfill({ json: { state, leaseId: "00000000-0000-4000-8000-000000000001", expiresAt: "2099-01-01T00:00:00.000Z" } });
      if (path.endsWith("/members")) return route.fulfill({ json: { members: [], nextCursor: null } });
      if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [], nextCursor: null } });
      if (path.endsWith("/channels")) return route.fulfill({ json: { connections: [] } });
      if (path.endsWith("/inbox")) return route.fulfill({ json: { conversations: [], nextCursor: null } });
      if (path.endsWith("/inbox-alerts")) return route.fulfill({ json: { alerts: [], unread: 0 } });
      return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
    });
    await page.goto("/app/inbox");
    const presence = page.locator('[aria-label="Your availability"]');
    await expect(presence.getByText("Availability unknown")).toBeVisible();
    await presence.getByRole("button", { name: "Available" }).click();
    await expect(presence.getByText("Available", { exact: true }).first()).toBeVisible();
    await presence.getByRole("button", { name: "Away" }).click();
    await expect(presence.getByText("Away", { exact: true }).first()).toBeVisible();
    fail = true;
    await presence.getByRole("button", { name: "Available" }).click();
    await expect(presence.getByRole("alert")).toBeVisible();
    await expect(presence.getByText("Away", { exact: true }).first()).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`presence-${theme}-${width}.png`) });
  });
}
