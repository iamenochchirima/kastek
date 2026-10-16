import { expect, test } from "@playwright/test";

const protectedReportingPaths = ["/analytics", "/content/analytics", "/analytics/playground"];

test.describe("customer analytics routes", () => {
  test("keeps reporting routes behind the authenticated workspace shell", async ({ page }) => {
    for (const path of protectedReportingPaths) {
      const response = await page.goto(path, { waitUntil: "domcontentloaded" });
      expect(response?.status(), `${path} should return a successful redirect target`).toBeLessThan(400);
      expect(new URL(page.url()).pathname, `${path} should redirect to sign in`).toBe("/login");
    }
  });

  test("does not expose the Core analytics gateway to an anonymous browser", async ({ request }) => {
    const response = await request.get("/api/analytics/catalog", { maxRedirects: 0 });
    expect([401, 403, 307, 308, 500], "anonymous reporting requests must remain protected or fail closed when Core is offline").toContain(response.status());
  });
});
