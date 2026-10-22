import type { NativeServiceConnector } from "../src/platform/api";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";

// UI contract fixtures. These tests do not authenticate with providers.
async function fixture(page: Page, available = true, role = "owner", override?: Partial<NativeServiceConnector>, options: { initialOperations?: string[]; reauthorizeOnSave?: boolean } = {}) {
  const connector: NativeServiceConnector = { id: "google-calendar", name: "Google Calendar", description: "Choose a calendar for appointments.", profileId: "google-calendar-v1", setup: { kind: "calendar_service", apiPath: "google-calendar", identityLabel: "Google" }, readiness: { available, reasons: available ? [] : [{ code: "GOOGLE_OAUTH_NOT_CONFIGURED", message: "Google sign-in has not been configured." }] }, ...override };
  let connection = { id: "calendar1", providerId: connector.id, operations: options.initialOperations ?? (connector.setup.kind === "calendar_service" ? ["calendar.availability", "calendar.book"] : []), bindingIds: [], name: "Appointments", status: "ready", account: { subject: "subject", email: "calendar@example.test" }, calendar: null as null | { id: string; name: string; timeZone: string; role: string }, revision: 1, policyRevision: 1, generation: 1, sharing: "private", customerDeploymentEligible: false, readiness: { state: "needs_configuration", reasons: [] } };
  const selectedOperations = new Set<string>(connection.operations);
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().method() === "GET" ? null : route.request().postDataJSON();
    if (body) requests.push({ path, body });
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: "org", name: "Calendar tests", role }] };
    else if (path.endsWith("/channels/catalogue")) data = { channels: [] };
    else if (path.endsWith("/channels")) data = { connections: [], deployments: [], websites: [] };
    else if (path.endsWith("/agents/summaries")) data = { agents: [], nextCursor: null };
    else if (path.endsWith("/connectors")) data = { connectors: [connector] };
    else if (path.endsWith(`/providers/${connector.id}/status`)) data = { provider: "google-calendar", available, reasons: available ? [] : [{ code: "GOOGLE_OAUTH_NOT_CONFIGURED", message: "Google sign-in has not been configured." }] };
    else if (path.endsWith(`/providers/${connector.id}/connections`)) { if (body) { data = { connection }; } else data = { connections: [connection] }; }
    else if (path.endsWith("/calendar1/operations")) {
      if (body) { expect(body.generation).toBe(connection.generation); selectedOperations.clear(); for (const id of body.operationIds) selectedOperations.add(id); connection = { ...connection, operations: body.operationIds, generation: connection.generation + 1, status: options.reauthorizeOnSave ? "authorization_required" : "ready" }; data = { connection }; }
      else data = { operations: (connector.operations ?? []).map(operation => ({ ...operation, selected: selectedOperations.has(operation.id) })), generation: connection.generation };
    }
    else if (path.endsWith("/calendar1/calendars")) data = { items: [{ id: "primary", name: "Appointments", timeZone: "Africa/Johannesburg", role: "owner" }] };
    else if (path.endsWith("/calendar1/calendar")) { expect(body.generation).toBe(connection.generation); expect(body.calendarId).toBe("primary"); connection = { ...connection, generation: connection.generation + 1, calendar: { id: "primary", name: "Appointments", timeZone: "Africa/Johannesburg", role: "owner" }, readiness: { state: "ready", reasons: [] } }; data = { connection }; }
    else if (path.endsWith("/calendar1/sharing")) { expect(body.generation).toBe(connection.generation); connection = { ...connection, generation: connection.generation + 1, sharing: body.sharing, customerDeploymentEligible: body.sharing === "organization_service" }; data = { connection }; }
    else if (path.endsWith("/calendar1/disconnect")) { expect(body.generation).toBe(connection.generation); connection = { ...connection, status: "disconnected", generation: connection.generation + 1, customerDeploymentEligible: false }; data = { connection }; }
    else if (path.endsWith("/calendar1/authorize")) { await route.fulfill({ status: 503, json: { error: { message: `${connector.setup.identityLabel} sign-in is temporarily unavailable.` } } }); return; }
    else if (path.endsWith("/connections")) data = { connections: [], targets: [], profiles: [] };
    else if (path.endsWith("/remote-connections") || path.endsWith("/api-connections")) data = { connections: [] };
    else { await route.fulfill({ status: 404, json: { error: { message: `Unexpected fixture ${path}` } } }); return; }
    await route.fulfill({ json: data });
  });
  await page.goto("/app/connections");
  return { requests, errors, connector };
}

test("Google calendar UI fixture requires an explicit calendar and booking service consent", async ({ page }) => {
  const state = await fixture(page);
  await page.getByRole("button", { name: "Connect or manage" }).click();
  await page.getByRole("button", { name: "Choose calendar" }).click();
  await page.getByRole("combobox", { name: "Calendar", exact: true }).selectOption("primary");
  await page.getByRole("button", { name: "Save calendar" }).click();
  await page.getByRole("button", { name: "Allow customer access" }).click();
  await expect(page.getByText("Availability uses the selected policy", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Allow access", exact: true }).click();
  await expect(page.getByText("Shared with the calendar service", { exact: false })).toBeVisible();
  expect(state.requests.find(request => request.path.endsWith("/sharing"))?.body).toEqual({ generation: 2, sharing: "organization_service" });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(process.cwd(), `../../../.audit/mock-google-calendar-${width}.png`), fullPage: true, animations: "disabled" });
  }
  await page.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.getByRole("button", { name: "Disconnect", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Choose calendar" })).toBeDisabled();
  expect(state.errors).toEqual([]);
});

test("Google calendar UI fixture exposes unavailable provider without a sign-in claim", async ({ page }) => {
  await fixture(page, false);
  await page.getByRole("button", { name: "View setup" }).click();
  await expect(page.getByRole("dialog").getByText("Google sign-in has not been configured.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect Google account" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in to Google" })).toBeDisabled();
});

test("Google calendar UI fixture preserves account and retries a failed authorization", async ({ page }) => {
  await fixture(page);
  await page.getByRole("button", { name: "Connect or manage" }).click();
  await page.getByRole("button", { name: "Sign in to Google" }).click();
  await expect(page.getByText("Google sign-in is temporarily unavailable.")).toBeVisible();
  await expect(page.getByText("calendar@example.test", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in to Google" })).toBeEnabled();
});

test("Google calendar UI fixture keeps member access owner managed", async ({ page }) => {
  await fixture(page, true, "member");
  await expect(page.getByRole("button", { name: "Owner access required" })).toBeDisabled();
});


test("calendar service UI fixture uses registry identity, path and labels", async ({ page }) => {
  const state = await fixture(page, true, "owner", { id: "calendar-fixture", name: "Appointment service", description: "A supported calendar integration.", profileId: "calendar-fixture-v3", setup: { kind: "calendar_service", apiPath: "calendar-fixture", identityLabel: "Fixture" } });
  await expect(page.getByRole("heading", { name: "Appointment service", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Google Calendar", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Connect or manage" }).click();
  await expect(page.getByRole("dialog").getByRole("heading", { name: "Appointment service", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in to Fixture", exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Connect Fixture account", exact: true })).toBeEnabled();
  await expect(page.getByRole("textbox", { name: "Connection name", exact: true })).toHaveValue("Appointment service");
  await page.getByRole("button", { name: "Choose calendar", exact: true }).click();
  await page.getByRole("combobox", { name: "Calendar", exact: true }).selectOption("primary");
  await page.getByRole("button", { name: "Save calendar", exact: true }).click();
  expect(state.requests[0].path).toBe("/api/organizations/org/providers/calendar-fixture/connections/calendar1/calendar"); expect(state.errors).toEqual([]);
});


test("registry UI fixture tolerates a connector without a specialized setup", async ({ page }) => {
  const state = await fixture(page);
  await page.route("**/connectors", route => route.fulfill({ json: { connectors: [{ id: "generic-mcp", name: "Workspace connector", description: "A configured tool integration.", profileId: "remote-mcp-v1", readiness: { available: true, reasons: [] } }, { id: "existing-provider", name: "Existing provider", description: "An integration configured from Tools.", profileId: "github-public-read-v1", setup: { kind: "existing_connections" }, readiness: { available: true, reasons: [] } }] } }));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Workspace connector", exact: true })).toBeVisible();
  await expect(page.getByText("Available from Tools", { exact: true })).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Existing provider", exact: true })).toBeVisible();
  await expect(page.getByText("Setup unavailable", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Connect or manage", exact: true })).toHaveCount(0); expect(state.errors).toEqual([]);
});


test("Microsoft Calendar fixture uses the registry path and explicit booking time zone", async ({ page }) => {
  const state = await fixture(page, true, "owner", { id: "microsoft-calendar", name: "Microsoft 365 Calendar", profileId: "microsoft-calendar-v1", setup: { kind: "calendar_service", apiPath: "unused-legacy-path", identityLabel: "Microsoft" } });
  await page.getByRole("button", { name: "Connect or manage" }).click();
  await page.getByRole("button", { name: "Choose calendar", exact: true }).click();
  await page.getByRole("combobox", { name: "Calendar", exact: true }).selectOption("primary");
  await page.getByRole("textbox", { name: "Booking time zone" }).fill("Europe/London");
  await page.getByRole("button", { name: "Save calendar", exact: true }).click();
  expect(state.requests[0]).toEqual({ path: "/api/organizations/org/providers/microsoft-calendar/connections/calendar1/calendar", body: { generation: 1, calendarId: "primary", timeZone: "Europe/London" } });
  expect(state.errors).toEqual([]);
});

test("HubSpot fixture selects actions before account authorization and saves exact action grants", async ({ page }) => {
  const state = await fixture(page, true, "owner", { id: "hubspot", name: "HubSpot Contacts", profileId: "hubspot-contacts-v1", setup: { kind: "crm_service", apiPath: "unused-legacy-path", identityLabel: "HubSpot" }, operations: [
    { id: "contacts.search", name: "Find contacts", description: "Find matching contacts.", effect: "read" },
    { id: "contacts.create", name: "Create contact", description: "Create a confirmed contact.", effect: "reviewed_write" },
  ] });
  await page.getByRole("button", { name: "Connect or manage" }).click();
  await expect(page.getByRole("button", { name: "Connect HubSpot account" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "Find contacts", exact: true }).check();
  await page.getByRole("button", { name: "Connect HubSpot account" }).click();
  await expect(page.getByText("HubSpot sign-in is temporarily unavailable.")).toBeVisible();
  expect(state.requests.find(request => request.path.endsWith("/connections"))?.body).toEqual({ name: "HubSpot Contacts", operations: ["contacts.search"], operationId: expect.any(String) });
  await expect(page.getByRole("button", { name: "Choose calendar" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Allow customer access" })).toHaveCount(0);
  await page.getByRole("button", { name: "Choose actions" }).first().click();
  await expect(page.getByRole("button", { name: "Save actions" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Create contact Confirmation required" }).first().check();
  await page.getByRole("button", { name: "Save actions" }).click();
  expect(state.requests.find(request => request.path.endsWith("/operations"))?.body).toEqual({ generation: 1, operationIds: ["contacts.create"] });
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    const dialog = page.getByRole("dialog").first();
    const bounds = await dialog.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.width).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(process.cwd(), `../../../.audit/mock-hubspot-${width}.png`), fullPage: true, animations: "disabled" });
  }
  expect(state.errors).toEqual([]);
});


test("provider creation retries reuse the same mutation key and preserve the agent return path", async ({ page }) => {
  const state = await fixture(page, true, "owner", { operations: [
    { id: "calendar.availability", name: "Check availability", description: "Read availability.", effect: "read" },
    { id: "calendar.book", name: "Book appointment", description: "Create an appointment.", effect: "reviewed_write" },
  ] });
  const returnTo = "/app/agents/11111111-1111-4111-8111-111111111111?section=configuration";
  await page.goto(`/app/connections?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("button", { name: "Connect or manage" }).click();
  await page.getByRole("checkbox", { name: "Check availability", exact: true }).check();
  await page.getByRole("button", { name: "Connect Google account" }).click();
  await expect(page.getByText("Google sign-in is temporarily unavailable.")).toBeVisible();
  await page.getByRole("button", { name: "Connect Google account" }).click();
  await expect.poll(() => state.requests.filter(request => request.path.endsWith("/authorize")).length).toBe(2);
  const attempts = state.requests.filter(request => request.path.endsWith("/connections"));
  expect(attempts).toHaveLength(2); expect(attempts[0].body.operationId).toBe(attempts[1].body.operationId); expect(attempts[0].body.operationId).toMatch(/^[0-9a-f-]{36}$/);
  expect(state.requests.filter(request => request.path.endsWith("/authorize")).every(request => request.body.returnTo === returnTo)).toBe(true);
  await page.getByRole("checkbox", { name: "Book appointment Confirmation required", exact: true }).check();
  await page.getByRole("button", { name: "Connect Google account" }).click();
  await expect.poll(() => state.requests.filter(request => request.path.endsWith("/connections")).length).toBe(3);
  expect(state.requests.filter(request => request.path.endsWith("/connections"))[2].body.operationId).not.toBe(attempts[0].body.operationId);
  expect(state.errors).toEqual([]);
});

for (const returnTo of ["https://other.example/app/agents/123", "/app/agents/../../settings", "/app/agents/123\\external"]) test(`provider authorization excludes unsafe return path ${returnTo}`, async ({ page }) => {
  const state = await fixture(page); await page.goto(`/app/connections?returnTo=${encodeURIComponent(returnTo)}`);
  await page.getByRole("button", { name: "Connect or manage" }).click();
  await page.getByRole("button", { name: "Sign in to Google" }).click();
  await expect(page.getByText("Google sign-in is temporarily unavailable.")).toBeVisible();
  expect(state.requests.find(request => request.path.endsWith("/authorize"))?.body).toEqual({});
});

test("calendar permissions can step up from reading to booking with reauthorization", async ({ page }) => {
  const state = await fixture(page, true, "owner", { operations: [
    { id: "calendar.availability", name: "Check availability", description: "Read availability.", effect: "read" },
    { id: "calendar.book", name: "Book appointment", description: "Create an appointment.", effect: "reviewed_write" },
  ] }, { initialOperations: ["calendar.availability"], reauthorizeOnSave: true });
  await page.getByRole("button", { name: "Connect or manage" }).click();
  await page.getByRole("button", { name: "Choose calendar", exact: true }).click();
  await page.getByRole("combobox", { name: "Calendar", exact: true }).selectOption("primary");
  await page.getByRole("button", { name: "Save calendar" }).click();
  await expect(page.getByRole("button", { name: "Allow customer access" })).toBeVisible();
  await page.getByRole("button", { name: "Choose actions" }).click();
  await expect(page.getByRole("button", { name: "Save actions" })).toBeVisible();
  await page.getByRole("checkbox", { name: "Book appointment Confirmation required", exact: true }).first().check();
  await page.getByRole("button", { name: "Save actions" }).click();
  await expect(page.getByText("Google sign-in is temporarily unavailable.")).toBeVisible();
  expect(state.requests.find(request => request.path.endsWith("/operations"))?.body).toEqual({ generation: 2, operationIds: ["calendar.availability", "calendar.book"] });
  expect(state.requests.filter(request => request.path.endsWith("/authorize"))).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Choose calendar", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Allow customer access" })).toHaveCount(0);
});

test("CRM sharing explicitly grants reviewed customer intake without record lookup", async ({ page }) => {
  const state = await fixture(page, true, "owner", { id: "hubspot", name: "HubSpot Contacts", profileId: "hubspot-contacts-v1", setup: { kind: "crm_service", apiPath: "hubspot", identityLabel: "HubSpot" }, operations: [
    { id: "contacts.create", name: "Create contact", description: "Save confirmed details.", effect: "reviewed_write" },
  ] }, { initialOperations: ["contacts.create"] });
  await page.getByRole("button", { name: "Connect or manage" }).click();
  await page.getByRole("button", { name: "Allow customer intake" }).click();
  await expect(page.getByText("Customers must confirm their exact contact details before saving. Customer record lookup stays unavailable.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Allow intake", exact: true }).click();
  await expect(page.getByText("Customer intake allowed", { exact: true })).toBeVisible();
  expect(state.requests.find(request => request.path.endsWith("/sharing"))?.body).toEqual({ generation: 1, sharing: "organization_service" });
  await expect(page.getByRole("button", { name: "Make private", exact: true })).toBeVisible();
});
