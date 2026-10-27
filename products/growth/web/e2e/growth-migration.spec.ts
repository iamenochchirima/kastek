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


test("updates contact fields through the form and reloads the saved record", async ({ page, request }) => {
  await page.goto("/contacts?q=27720001111");
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.getByRole("dialog", { name: "Search results", exact: true }).getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("textbox", { name: "Full name", exact: true }).fill("Migration contact edit");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Contact updated.", { exact: true })).toBeVisible();
  await page.goto("/contacts?q=27720001111");
  await expect(page.getByRole("cell", { name: "Migration contact edit", exact: true })).toBeVisible();
  const state = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  expect(state.contacts[0].fullName).toBe("Migration contact edit");
});

test("creates a campaign through its setup and confirmation screens", async ({ page, request }) => {
  await page.goto("/campaigns/create");
  await page.getByRole("textbox", { name: /Campaign base name/ }).fill("migration-campaign");
  await page.getByRole("combobox", { name: "Template", exact: true }).click();
  await page.getByRole("option", { name: /fixture_offer/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Confirm campaign", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create campaign", exact: true }).click();
  await expect(page).toHaveURL(/\/campaigns\?notice=/);
  await page.reload();
  await expect(page.getByRole("cell", { name: /^migration-campaign/ })).toBeVisible();
  const state = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  expect(state.campaigns.some((campaign: { name: string; batchSize: number }) => campaign.name === "migration-campaign" && campaign.batchSize === 1)).toBe(true);
});

test("submits a template and reloads its pending provider-review state", async ({ page, request }) => {
  await page.setViewportSize({ width: 768, height: 1000 });
  await page.goto("/templates");
  await page.getByRole("button", { name: "Create new template", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: /Template name/ }).fill("migration_template");
  await dialog.getByRole("textbox", { name: /Body/ }).fill("Migration offer. Reply STOP to opt out.");
  await dialog.getByRole("button", { name: "Submit template", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("migration_template", { exact: true }).first()).toBeVisible();
  const state = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  expect(state.templates.find((template: { templateName: string }) => template.templateName === "migration_template").status).toBe("PENDING");
});

test("saves a content draft from the complete composer and reloads it", async ({ page, request }) => {
  await page.goto("/content");
  await page.getByRole("button", { name: "Create post", exact: true }).click();
  const composer = page.getByRole("dialog");
  await composer.getByRole("button", { name: /Fixture Facebook Page/ }).click();
  await composer.getByRole("button", { name: "Continue", exact: true }).click();
  await composer.getByPlaceholder("Write your post...").fill("Migration draft saved through the composer.");
  await composer.getByRole("button", { name: "Continue", exact: true }).click();
  await composer.getByPlaceholder("Write the Facebook version...").fill("Migration draft saved through the composer.");
  await composer.getByRole("button", { name: "Continue", exact: true }).click();
  await composer.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(composer).toHaveCount(0);
  await page.reload();
  await expect(page.getByText("Migration draft saved through the composer.", { exact: true }).first()).toBeVisible();
  const state = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  expect(state.posts.some((post: { content: string; status: string }) => post.content === "Migration draft saved through the composer." && post.status === "DRAFT")).toBe(true);
});

test("sends an Inbox reply and reloads its saved message", async ({ page, request }) => {
  await page.goto("/inbox?conversation=fixture-inbox");
  const input = page.getByPlaceholder("Message Fixture customer...");
  await input.fill("Migration Inbox reply");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(input).toHaveValue("");
  await page.reload();
  await expect(page.getByText("Migration Inbox reply", { exact: true }).first()).toBeVisible();
  const state = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  expect(state.inboxMessages.some((message: { text: string; status: string }) => message.text === "Migration Inbox reply" && message.status === "SENT")).toBe(true);
});

test("returns from controlled checkout and verifies the receipt once", async ({ page, request }) => {
  const initial = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  const count = (state: { requests: Array<{ path: string }> }) => state.requests.filter(item => item.path === "/api/billing/checkout/fixture-receipt/verify").length;
  const before = count(initial);
  await page.goto("/upgrade/fixture-plan");
  await page.getByRole("button", { name: "Upgrade", exact: true }).click();
  await expect(page).toHaveURL(/section=billing.*reference=fixture-receipt/);
  await expect(page.getByText("Payment complete", { exact: true })).toBeVisible();
  // Give an erroneous revalidation/effect loop time to issue a second request.
  await page.waitForTimeout(250);
  const state = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  expect(count(state) - before).toBe(1);
});

test("launches the selected OAuth flow and displays its controlled failure return", async ({ page, request }) => {
  await page.goto("/connections");
  await page.getByRole("button", { name: "Add Facebook Pages", exact: true }).click();
  await page.getByRole("button", { name: "Continue to Meta", exact: true }).click();
  await expect(page).toHaveURL(/connections\?error=fixture_provider_unavailable/);
  await expect(page.getByText("Connection could not be completed: fixture_provider_unavailable", { exact: true })).toBeVisible();
  const state = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  expect(state.requests.some((item: { path: string }) => item.path === "/api/social/oauth/meta/start")).toBe(true);
  await expect(page.getByRole("button", { name: "Add Facebook Pages", exact: true })).toBeVisible();
});

test("shows pending navigation while a route loader waits", async ({ page }) => {
  await page.goto("/workspace");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  let release!: () => void;
  const delayed = new Promise<void>(resolve => { release = resolve; });
  await page.route("**/api/whatsapp/contacts", async route => { await delayed; await route.continue(); });
  await page.getByRole("link", { name: "Contacts", exact: true }).first().click();
  try { await expect(page.getByRole("progressbar", { name: "Loading page", exact: true })).toBeVisible(); }
  finally { release(); }
  await expect(page).toHaveURL(/\/contacts$/);
  await expect(page.getByRole("progressbar", { name: "Loading page", exact: true })).toHaveCount(0);
});


test("shares bootstrap reads between matched layout and page loaders", async ({ page, request }) => {
  const state = () => request.get("http://127.0.0.1:4311/__fixture/migration").then(response => response.json());
  const before = await state();
  await page.goto("/workspace/settings?section=profile");
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  const after = await state();
  for (const path of ["/api/auth/me", "/api/orgs"]) {
    const count = (value: { requests: Array<{ path: string }> }) => value.requests.filter(item => item.path === path).length;
    expect(count(after) - count(before), path).toBe(1);
  }
});


test("persists shared workspace theme and density through reload", async ({ page }) => {
  await page.goto("/workspace/settings?section=appearance");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(255, 255, 255)");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await page.getByRole("button", { name: "compact", exact: true }).click();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await expect(page.locator("html")).toHaveAttribute("data-density", "compact");
  await expect(page.locator("body")).toHaveCSS("background-color", "rgb(17, 19, 22)");
  await expect(page.getByRole("button", { name: "Dark", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "System", exact: true }).click();
  await page.emulateMedia({ colorScheme: "light" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.reload();
  await expect(page.getByRole("button", { name: "System", exact: true })).toHaveAttribute("aria-pressed", "true");
});
