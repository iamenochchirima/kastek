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
  await page.getByRole("textbox", { name: "API key name", exact: true }).fill("Migration browser key");
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
  await page.getByRole("button", { name: /^View contact / }).first().click();
  const details = page.getByRole("complementary", { name: "Contact details", exact: true });
  await expect(details.getByText("+27720001111", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Close contact details", exact: true }).click();
  await page.getByRole("button", { name: "Edit", exact: true }).first().click();
  await page.getByRole("textbox", { name: "Full name", exact: true }).fill("Migration contact edit");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Contact updated.", { exact: true })).toBeVisible();
  await page.goto("/contacts?q=27720001111");
  await expect(page.getByRole("button", { name: "View contact Migration contact edit", exact: true })).toBeVisible();
  const state = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  expect(state.contacts[0].fullName).toBe("Migration contact edit");
  await page.getByRole("button", { name: /^Excluded/ }).click();
  await expect(page.getByRole("button", { name: "View contact Migration contact edit", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: /^All contacts/ }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "View contact Migration contact edit", exact: true }).click();
  const mobileDetails = page.getByRole("dialog", { name: "Contact details", exact: true });
  await expect(mobileDetails).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(mobileDetails).toBeHidden();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("creates a campaign through its setup and confirmation screens", async ({ page, request }) => {
  await page.goto("/campaigns/create");
  await page.getByRole("textbox", { name: "Campaign name", exact: true }).fill("migration-campaign");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Batch size", exact: true }).fill("1");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await page.getByRole("combobox", { name: "Marketing template", exact: true }).click();
  await page.getByRole("option", { name: /fixture_offer/ }).click();
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Review campaign", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page).toHaveURL(/\/campaigns\/[^/]+\?notice=/);
  await page.goto("/campaigns");
  await page.reload();
  await expect(page.getByRole("link", { name: "migration-campaign", exact: true })).toBeVisible();
  const state = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  expect(state.campaigns.some((campaign: { name: string; batchSize: number; status: string }) => campaign.name === "migration-campaign" && campaign.batchSize === 1 && campaign.status === "DRAFT")).toBe(true);
  expect(state.requests.some((request: { path: string }) => request.path.endsWith("/launch"))).toBe(false);
});

test("submits a template and reloads its pending provider-review state", async ({ page, request }) => {
  await page.setViewportSize({ width: 768, height: 1000 });
  await page.goto("/templates");
  await page.getByRole("button", { name: "New template", exact: true }).click();
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
  await page.getByRole("button", { name: "Create post", exact: true }).first().click();
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
  await page.getByRole("tab", { name: /^Drafts/ }).click();
  await page.getByRole("textbox", { name: "Search posts", exact: true }).fill("Migration draft saved");
  await expect(page.getByRole("region", { name: "Posts", exact: true }).getByRole("row")).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: /^Preview / }).click();
  const preview = page.getByRole("dialog", { name: "Post preview", exact: true });
  await expect(preview.getByText("Migration draft saved through the composer.", { exact: true })).toBeVisible();
  await preview.getByRole("button", { name: "Edit post", exact: true }).click();
  // Editing opens the selected record directly, rather than the creation wizard.
  const editComposer = page.getByRole("dialog", { name: "Edit post", exact: true });
  await expect(editComposer).toBeVisible();
  await expect(editComposer.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  await expect(editComposer.getByRole("button", { name: "Save changes", exact: true })).toBeVisible();
  await expect(editComposer.getByPlaceholder("Write your post...")).toHaveValue("Migration draft saved through the composer.");
});

for (const width of [390, 768, 1440]) for (const colorScheme of ["light", "dark"] as const) test(`edits an unconnected Facebook draft at ${width}px in ${colorScheme}`, async ({ page, request }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme });
  await page.addInitScript(theme => localStorage.setItem("kasitek-theme", theme), colorScheme);
  await page.route("**/api/social/channels", route => route.fulfill({ json: { channels: [] } }));
  const text = `Unconnected Facebook draft ${width} ${colorScheme}`;
  await page.goto("/content");
  await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
  await page.getByRole("button", { name: "Create post", exact: true }).first().click();
  const composer = page.getByRole("dialog");
  await composer.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(composer.getByRole("alert")).toHaveText("Choose at least one platform.");
  await composer.getByRole("button", { name: "Draft for Facebook", exact: true }).click();
  await composer.getByRole("button", { name: "Continue", exact: true }).click();
  await composer.getByPlaceholder("Write your post...").fill(text);
  await composer.getByRole("button", { name: "Continue", exact: true }).click();
  await composer.getByPlaceholder("Write the Facebook version...").fill(`${text} Facebook copy`);
  await composer.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(composer.getByRole("button", { name: "Post now", exact: true })).toBeDisabled();
  await composer.locator('input[type="datetime-local"]').fill("2030-01-01T09:00");
  await expect(composer.getByRole("button", { name: "Schedule post", exact: true })).toBeDisabled();
  expect(await composer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("unconnected-draft-review.png"), fullPage: true });
  await composer.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(composer).toHaveCount(0);
  const before = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  const saved = before.posts.find((post: { content: string }) => post.content === text);
  expect(saved.channelSelections).toEqual({});
  await page.reload();
  await page.getByRole("tab", { name: /^Drafts/ }).click();
  await page.getByRole("textbox", { name: "Search posts", exact: true }).fill(text);
  await page.getByRole("button", { name: /^Preview / }).click();
  await page.getByRole(width < 1280 ? "dialog" : "complementary", { name: "Post preview", exact: true }).getByRole("button", { name: "Edit post", exact: true }).click();
  await expect(composer.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  await expect(composer.getByPlaceholder("Write your post...")).toHaveValue(text);
  await composer.getByPlaceholder("Write your post...").fill(`${text} edited`);
  await expect(composer.getByPlaceholder("Write the Facebook version...")).toHaveValue(`${text} Facebook copy`);
  await composer.getByPlaceholder("Write the Facebook version...").fill(`${text} Facebook copy edited`);
  expect(await composer.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("direct-draft-editor.png"), fullPage: true });
  await composer.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(composer).toHaveCount(0);
  await page.reload();
  const after = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  expect(after.posts.filter((post: { content: string }) => post.content.startsWith(text))).toHaveLength(1);
  expect(after.posts.find((post: { id: string }) => post.id === saved.id)).toMatchObject({ content: `${text} edited`, variants: [{ platform: "FACEBOOK", content: `${text} Facebook copy edited` }], channelSelections: {}, status: "DRAFT" });
  await expect(page.getByText(`${text} edited`, { exact: true }).first()).toBeVisible();
});

test("publishes a selected Page with a valid JSON body and preserves the draft after an unreadable response", async ({ page, request }) => {
  let publishingRequests = 0;
  const publishBodies: unknown[] = [];
  await page.route(/\/api\/social\/posts\/[^/]+\/publish-batch\/preflight$/, async route => {
    const postId = new URL(route.request().url()).pathname.split("/")[4];
    await route.fulfill({ json: { postId, status: "READY", snapshotHash: "fixture", mediaCount: 0, targets: [{ platform: "FACEBOOK", accountName: "Fixture Facebook Page", state: "READY", status: "READY" }] } });
  });
  await page.route(/\/api\/social\/posts\/[^/]+\/publish-batch$/, async route => {
    publishingRequests++;
    publishBodies.push(JSON.parse(route.request().postData() || ""));
    if (publishingRequests === 1) {
      await route.fulfill({ status: 400, contentType: "text/plain", body: "Json deserialize error" });
      return;
    }
    const postId = new URL(route.request().url()).pathname.split("/")[4];
    const state = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
    const post = state.posts.find((item: { id: string }) => item.id === postId);
    await route.fulfill({ json: { post: { ...post, status: "PUBLISHED" }, batch: { status: "PUBLISHED", targets: [] } } });
  });
  await page.goto("/content");
  await page.getByRole("button", { name: "Create post", exact: true }).first().click();
  const composer = page.getByRole("dialog");
  await composer.getByRole("button", { name: /Fixture Facebook Page/ }).click();
  await composer.getByRole("button", { name: "Continue", exact: true }).click();
  await composer.getByPlaceholder("Write your post...").fill("Safe publishing body regression");
  await composer.getByRole("button", { name: "Continue", exact: true }).click();
  await composer.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(composer.getByText("Fixture Facebook Page", { exact: true })).toBeVisible();
  await expect(composer.getByText("Not selected", { exact: true })).toHaveCount(0);
  await composer.getByRole("button", { name: "Post now", exact: true }).click();
  await expect(composer.getByRole("alert")).toContainText("Unable to read the publishing response. Check the post status before retrying");
  await expect(composer.getByText("Not selected", { exact: true })).toHaveCount(0);
  expect(publishBodies).toEqual([{}]);
  const beforeRetry = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  const saved = beforeRetry.posts.filter((post: { content: string }) => post.content === "Safe publishing body regression");
  expect(saved).toHaveLength(1);
  expect(saved[0].status).toBe("DRAFT");
  await composer.getByRole("button", { name: "Post now", exact: true }).click();
  await expect(composer).toHaveCount(0);
  expect(publishBodies).toEqual([{}, {}]);
  const afterRetry = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  expect(afterRetry.posts.filter((post: { content: string }) => post.content === "Safe publishing body regression")).toHaveLength(1);
});

test("schedules content with the browser's explicit timezone instant and retains it on reload", async ({ page, request }) => {
  await page.goto("/content");
  await page.getByRole("button", { name: "Create post", exact: true }).first().click();
  const composer = page.getByRole("dialog");
  await composer.getByRole("button", { name: /Fixture Facebook Page/ }).click();
  await composer.getByRole("button", { name: "Continue", exact: true }).click();
  await composer.getByPlaceholder("Write your post...").fill("Scheduled timezone journey");
  await composer.getByRole("button", { name: "Continue", exact: true }).click();
  await composer.getByPlaceholder("Write the Facebook version...").fill("Scheduled timezone journey");
  await composer.getByRole("button", { name: "Continue", exact: true }).click();
  await composer.locator('input[type="datetime-local"]').fill("2030-01-01T09:00");
  const intendedInstant = await page.evaluate(() => new Date("2030-01-01T09:00").toISOString());
  const sent = page.waitForRequest(request => request.method() === "POST" && new URL(request.url()).pathname === "/api/social/posts");
  await composer.getByRole("button", { name: "Schedule post", exact: true }).click();
  const outgoing = await sent;
  expect(outgoing.postDataJSON().scheduledFor).toBe(intendedInstant);
  expect(outgoing.headers()["idempotency-key"]).toMatch(/^manual-content-save:/);
  await expect(composer).toHaveCount(0);
  await page.reload();
  const state = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  const scheduled = state.posts.find((post: { content: string }) => post.content === "Scheduled timezone journey");
  expect(scheduled).toMatchObject({ status: "SCHEDULED", scheduledFor: intendedInstant });
  await page.getByRole("textbox", { name: "Search posts", exact: true }).fill("Scheduled timezone journey");
  await page.getByRole("button", { name: "Actions for Scheduled timezone journey", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit post", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit post", exact: true });
  await expect(editor.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  await expect(editor.locator('input[type="datetime-local"]')).toHaveValue("2030-01-01T09:00");
  await editor.getByRole("textbox", { name: "Post text", exact: true }).fill("Scheduled timezone journey edited");
  await editor.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const editedState = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  expect(editedState.posts.find((post: { id: string }) => post.id === scheduled.id)).toMatchObject({ content: "Scheduled timezone journey edited", status: "SCHEDULED", scheduledFor: intendedInstant, channelSelections: scheduled.channelSelections });
});

test("sends an Inbox reply and reloads its saved message", async ({ page, request }) => {
  await page.goto("/inbox?conversation=fixture-inbox");
  const input = page.getByRole("textbox", { name: "Reply message", exact: true });
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
  await page.getByRole("button", { name: "Connect Facebook", exact: true }).click();
  await page.getByRole("button", { name: "Continue to Meta", exact: true }).click();
  await expect(page).toHaveURL(/connections\?error=fixture_provider_unavailable/);
  await expect(page.getByText("Connection could not be completed: fixture_provider_unavailable", { exact: true })).toBeVisible();
  const state = await (await request.get("http://127.0.0.1:4311/__fixture/migration")).json();
  expect(state.requests.some((item: { path: string }) => item.path === "/api/social/oauth/meta/start")).toBe(true);
  await expect(page.getByRole("button", { name: "Connect Facebook", exact: true })).toBeVisible();
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

test("filters connection accounts and handles an unavailable email authorization", async ({ page }) => {
  await page.goto("/connections");
  const accounts = page.getByRole("region", { name: "Connected accounts", exact: true });
  await expect(accounts.getByRole("button", { name: "Fixture WhatsApp", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Search connections", exact: true }).fill("no-such-account");
  await expect(accounts.getByText("No matching accounts", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Search connections", exact: true }).fill("");
  await page.getByRole("group", { name: "Connection status", exact: true }).getByRole("button", { name: "Needs attention 0", exact: true }).click();
  await expect(accounts.getByText("No matching accounts", { exact: true })).toBeVisible();
  await page.getByRole("group", { name: "Connection status", exact: true }).getByRole("button", { name: "All 1", exact: true }).click();
  await expect(accounts.getByRole("button", { name: "Fixture WhatsApp", exact: true })).toBeVisible();
  await page.getByRole("group", { name: "Platform category", exact: true }).getByRole("button", { name: "Email", exact: true }).click();
  await expect(page.getByRole("button", { name: "Connect Facebook", exact: true })).toHaveCount(0);
  await page.route("**/api/email/oauth/google/start?returnTo=/connections", route => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Email provider not configured" }) }));
  await page.getByRole("button", { name: "Connect Gmail", exact: true }).click();
  await expect(page.getByText("Email provider not configured", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Gmail", exact: true })).toBeEnabled();
});

for (const finalStatus of ["PUBLISHED", "FAILED"] as const) test(`refreshes processing content to ${finalStatus.toLowerCase()} without reloading or replacing composer input`, async ({ page }) => {
  await page.setViewportSize({ width: finalStatus === "PUBLISHED" ? 1440 : 390, height: 900 });
  const createdAt = new Date().toISOString();
  let status: "PROCESSING" | typeof finalStatus = "PROCESSING";
  let reads = 0;
  await page.route("**/api/social/posts", async route => {
    if (route.request().method() !== "GET") return route.continue();
    reads++;
    if (finalStatus === "FAILED" && reads === 2) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Controlled temporary read failure" }) });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ posts: [{
      id: "automatic-status-post", userId: "fixture-user", primaryChannelId: "fixture-social",
      title: "Automatic status journey", content: "Automatic status journey", channels: ["FACEBOOK"],
      status, createdAt, updatedAt: createdAt, scheduledFor: null,
      publishedAt: status === "PUBLISHED" ? createdAt : null, variants: [], media: [],
      publishJobs: [{ id: "automatic-status-job", postId: "automatic-status-post", platform: "FACEBOOK",
        status: status === "PROCESSING" ? "QUEUED" : status, channelConnectionId: "fixture-social",
        externalPostId: status === "PUBLISHED" ? "fixture-page_post" : null,
        errorMessage: status === "FAILED" ? "Controlled provider failure" : null }],
    }] }) });
  });
  await page.goto("/content");
  await expect(page.getByRole("region", { name: "Posts", exact: true }).getByText("Processing", { exact: true }).filter({ visible: true }).first()).toBeVisible();
  const beforeChange = reads;
  await page.getByRole("button", { name: "Create post", exact: true }).first().click();
  const composer = page.getByRole("dialog");
  await composer.getByRole("button", { name: /Fixture Facebook Page/ }).click();
  await composer.getByRole("button", { name: "Continue", exact: true }).click();
  await composer.getByPlaceholder("Write your post...").fill("Keep this unsaved composition");
  status = finalStatus;
  await expect.poll(() => reads, { timeout: 10000 }).toBeGreaterThan(beforeChange);
  await expect(composer.getByPlaceholder("Write your post...")).toHaveValue("Keep this unsaved composition");
  await composer.getByRole("button", { name: "Close composer", exact: true }).click();
  await expect(page.getByRole("region", { name: "Posts", exact: true }).getByText(finalStatus === "PUBLISHED" ? "Published" : "Failed", { exact: true }).filter({ visible: true }).first()).toBeVisible({ timeout: 10000 });
  if (finalStatus === "FAILED") expect(reads).toBeGreaterThanOrEqual(3);
  const readsAfterCompletion = reads;
  await page.waitForTimeout(3500);
  expect(reads).toBe(readsAfterCompletion);
});

test("refreshes post details, batch and activity after provider publication without reloading", async ({ page }) => {
  const createdAt = new Date().toISOString();
  let published = false;
  let postReads = 0;
  await page.route("**/api/social/posts/fixture-post", async route => {
    postReads++;
    const status = published ? "PUBLISHED" : "PROCESSING";
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ post: {
      id: "fixture-post", userId: "fixture-user", title: "Detail status journey", content: "Detail status journey",
      primaryChannelId: "fixture-social", channels: ["FACEBOOK"], status, createdAt, updatedAt: createdAt,
      scheduledFor: null, publishedAt: published ? createdAt : null, variants: [], media: [],
      publishJobs: [{ id: "detail-job", postId: "fixture-post", platform: "FACEBOOK", status,
        channelConnectionId: "fixture-social", publishedAt: published ? createdAt : null,
        externalPostId: published ? "fixture-page_post" : null }],
    } }) });
  });
  await page.route("**/api/social/posts/fixture-post/publish-batch", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ batch: {
    batchId: "detail-batch", status: published ? "PUBLISHED" : "PROCESSING", targetCount: 1,
    publishedCount: published ? 1 : 0, processingCount: published ? 0 : 1, failedCount: 0, blockedCount: 0, unknownCount: 0,
    targets: [{ platform: "FACEBOOK", accountName: "Fixture Facebook Page", state: published ? "PUBLISHED" : "PROCESSING", remediationMode: "WAIT" }],
  } }) }));
  await page.route("**/api/social/posts/fixture-post/activity", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ events: published ? [{
    id: "detail-published-event", type: "provider.job.published", status: "PUBLISHED", platform: "FACEBOOK", source: "provider",
    occurredAt: createdAt, message: "Controlled provider publication",
  }] : [] }) }));
  await page.goto("/content/posts/fixture-post");
  await expect(page.getByRole("heading", { name: "Detail status journey", exact: true })).toBeVisible();
  await expect(page.getByText("0 of 1 published", { exact: true })).toBeVisible();
  published = true;
  await expect(page.getByText("1 of 1 published", { exact: true })).toBeVisible({ timeout: 12000 });
  await expect(page.getByText(/Controlled provider publication/)).toBeVisible();
  await expect(page.getByText("PUBLISHED", { exact: true }).first()).toBeVisible();
  const terminalReads = postReads;
  await page.waitForTimeout(5500);
  expect(postReads).toBe(terminalReads);
});

for (const width of [390, 1440]) for (const removePhoto of [false, true]) test(`${removePhoto ? "removes the photo from" : "updates"} a published Facebook caption directly at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 900 });
  const post = { id: "published-edit-fixture", userId: "fixture-user", primaryChannelId: "fixture-social", title: "Published edit test", prompt: null, content: "Original caption", channels: ["FACEBOOK"], status: "PUBLISHED", scheduledFor: null, publishedAt: "2026-11-01T12:00:00Z", createdAt: "2026-11-01T12:00:00Z", updatedAt: "2026-11-01T12:00:00Z", metadata: {}, variants: [{ id: "fixture-variant", platform: "FACEBOOK", content: "Original caption", status: "APPROVED", aiGenerated: false }], media: [{ id: "published-edit-media", assetId: "published-edit-media", kind: "IMAGE", mimeType: "image/png", fileName: "published-image.png", byteSize: 1000, width: 640, height: 360, durationMs: null, altText: "Published image", sortOrder: 0, metadata: null }], publishJobs: [{ id: "published-edit-job", platform: "FACEBOOK", status: "PUBLISHED", channelConnectionId: "fixture-social", externalPostId: "same-facebook-post", errorMessage: null, metadata: {} }] };
  let updateRequests = 0;
  await page.route("**/api/social/media/published-edit-media", route => route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#1e293b"/><text x="320" y="190" text-anchor="middle" fill="white" font-size="32">Published image</text></svg>' }));
  await page.route("**/api/social/posts", route => route.fulfill({ json: { posts: [post] } }));
  await page.route("**/api/social/posts/published-edit-fixture/update-published", async route => {
    updateRequests++;
    expect(route.request().postDataJSON()).toEqual({ content: "Updated caption", expectedUpdatedAt: "2026-11-01T12:00:00Z", ...(removePhoto ? { removePhoto: true } : {}) });
    expect(route.request().headers()["idempotency-key"]).toBeTruthy();
    if (updateRequests === 1) { await route.fulfill({ status: 409, json: { error: "Facebook is temporarily unavailable." } }); return; }
    post.content = "Updated caption";
    post.variants[0].content = "Updated caption";
    if (removePhoto) post.media = [];
    await route.fulfill({ json: { post } });
  });
  await page.goto("/content");
  await page.getByRole("button", { name: "Actions for Published edit test", exact: true }).click();
  await page.getByRole("menuitem", { name: "Edit post", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Edit Facebook post", exact: true });
  await expect(editor.getByText("Fixture Facebook Page", { exact: true })).toBeVisible();
  await expect(editor.getByRole("button", { name: "Continue", exact: true })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Add media", exact: true })).toHaveCount(0);
  await expect(editor.getByRole("button", { name: "Remove media", exact: true })).toHaveCount(0);
  await expect(editor.getByRole("img", { name: "Published image", exact: true })).toBeVisible();
  if (removePhoto) {
    await editor.getByRole("button", { name: "Remove photo", exact: true }).click();
    await expect(editor.getByText("Photo will be removed", { exact: true })).toBeVisible();
    await expect(editor.getByRole("img", { name: "Published image", exact: true })).toHaveCount(0);
    await editor.getByRole("button", { name: "Undo photo removal", exact: true }).click();
    await expect(editor.getByRole("img", { name: "Published image", exact: true })).toBeVisible();
    await editor.getByRole("button", { name: "Remove photo", exact: true }).click();
  }
  await editor.getByRole("textbox", { name: "Facebook text", exact: true }).fill("Updated caption");
  await editor.getByRole("button", { name: "Update on Facebook", exact: true }).click();
  await expect(editor.getByRole("alert")).toHaveText("Facebook is temporarily unavailable.");
  await expect(editor.getByRole("textbox", { name: "Facebook text", exact: true })).toHaveValue("Updated caption");
  if (removePhoto) {
    await expect(editor.getByRole("button", { name: "Undo photo removal", exact: true })).toBeVisible();
    expect(post.media).toHaveLength(1);
  }
  expect(await editor.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("direct-published-editor.png"), fullPage: true });
  await editor.getByRole("button", { name: "Update on Facebook", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(post.publishJobs[0].externalPostId).toBe("same-facebook-post");
  expect(updateRequests).toBe(2);
  expect(post.media).toHaveLength(removePhoto ? 0 : 1);
});
