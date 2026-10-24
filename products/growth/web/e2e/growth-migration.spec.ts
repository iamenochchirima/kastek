import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";

const contract = JSON.parse(readFileSync(new URL("../scripts/route-contract.json", import.meta.url), "utf8")) as { routes: Array<{ path: string }> };
// This suite exercises the production browser bundle with a controlled API. It does
// not certify provider authorization, actual delivery, model behavior or database persistence.
for (const entry of contract.routes) test(`preserves route ${entry.path}`, async ({ page, request }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && /React error|ErrorBoundary|hydration|Minified React/i.test(message.text())) errors.push(message.text()); });
  let path = entry.path.replace(":planKey", "fixture-plan").replace(":token", "invalid-fixture-token");
  if (path === "/agents/conversations/:id") {
    const state = await (await request.get("http://127.0.0.1:4311/__fixture/attempts")).json();
    path = path.replace(":id", state.conversations[0].id);
  } else path = path.replace(":id", path.startsWith("/campaigns") ? "fixture-campaign" : path.startsWith("/contacts") ? "fixture-customer" : "fixture-post");
  const response = await page.goto(path);
  if (path === "/analytics/playground") {
    expect(response?.status()).toBe(404);
    expect(response?.headers()["x-robots-tag"]).toContain("noindex");
    expect(errors).toEqual([]);
    return;
  }
  if (path.startsWith("/agents/conversations/")) await expect(page.getByRole("region", { name: "Agent conversation" })).toBeVisible();
  else await expect(page.getByRole("heading").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Unable to load workspace", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Page not found", exact: true })).toHaveCount(0);
  if (path !== "/") await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  expect(errors).toEqual([]);
});

test("serves crawlable landing HTML and keeps private routes out of sitemap", async ({ request }) => {
  const root = await request.get("/");
  const html = await root.text();
  expect(html).toContain("Growth | KasiTek");
  expect(html).toContain('rel="canonical" href="https://growth.kasitek.co.za/"');
  expect(html).toMatch(/<h1[\s>]/);
  const sitemap = await (await request.get("/sitemap.xml")).text();
  expect(sitemap).toContain("https://growth.kasitek.co.za/");
  for (const route of ["/agents", "/inbox", "/workspace"]) expect(sitemap).not.toContain(route);
  expect((await request.get("/not-a-growth-route")).status()).toBe(404);
});

for (const width of [390, 768, 1440]) test(`keeps the workspace usable at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 900 });
  await page.goto("/workspace");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("saves profile edits and reloads their controlled API state", async ({ page, request }) => {
  await page.goto("/workspace/settings?section=profile");
  await page.getByRole("textbox", { name: "Full name", exact: true }).fill("Migration profile");
  await page.getByRole("button", { name: "Save profile", exact: true }).click();
  await expect(page.getByText("Profile updated.", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Full name", exact: true })).toHaveValue("Migration profile");
  const state = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  expect(state.profile.name).toBe("Migration profile");
});

test("creates a booking service and reloads its controlled API state", async ({ page, request }) => {
  await page.goto("/bookings");
  await page.getByRole("button", { name: "Add service", exact: true }).click();
  await page.getByRole("textbox", { name: "Service name", exact: true }).fill("Migration consultation");
  await page.getByRole("button", { name: "Create service", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Migration consultation", { exact: true })).toBeVisible();
  const state = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  expect(state.bookingServices.some((service: { name: string }) => service.name === "Migration consultation")).toBe(true);
});

test("creates a developer key and reloads its controlled API state", async ({ page, request }) => {
  await page.goto("/developers/api-keys");
  await page.getByPlaceholder("Key name, for example Local development").fill("Migration browser key");
  await page.getByRole("button", { name: "Create API key", exact: true }).click();
  await expect(page.getByText("Copy this API key now", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("cell", { name: "Migration browser key", exact: true })).toBeVisible();
  const state = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  expect(state.developerKeys.some((key: { name: string }) => key.name === "Migration browser key")).toBe(true);
});


test("renders sign-in and signup when the session is absent and guards private routes", async ({ page }) => {
  await page.route("**/api/auth/me", route => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Unauthorized" }) }));
  await page.goto("/login");
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
  await page.goto("/signup");
  await expect(page.getByRole("heading", { name: "Create account", exact: true })).toBeVisible();
  await page.goto("/agents");
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible();
});
