import type { CalendarServiceConnector } from "../src/platform/api";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";

// UI contract fixtures. These tests do not authenticate with Google.
async function fixture(page: Page, available = true, role = "owner", override?: Partial<CalendarServiceConnector>) {
  const connector: CalendarServiceConnector = { id: "google-calendar", name: "Google Calendar", description: "Choose a calendar for appointments.", profileId: "google-calendar-v1", setup: { kind: "calendar_service", apiPath: "google-calendar", identityLabel: "Google" }, readiness: { available, reasons: available ? [] : [{ code: "GOOGLE_OAUTH_NOT_CONFIGURED", message: "Google sign-in has not been configured." }] }, ...override };
  let connection = { id: "calendar1", name: "Appointments", status: "active", account: { subject: "subject", email: "calendar@example.test" }, calendar: null as null | { id: string; name: string; timeZone: string; role: string }, revision: 1, policyRevision: 1, generation: 1, sharing: "private", customerDeploymentEligible: false, readiness: { state: "needs_configuration", reasons: [] } };
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().method() === "GET" ? null : route.request().postDataJSON();
    if (body) requests.push({ path, body });
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: "org", name: "Calendar tests", role }] };
    else if (path.endsWith("/connectors")) data = { connectors: [connector] };
    else if (path.endsWith(`/${connector.setup.apiPath}/status`)) data = { provider: "google-calendar", available, reasons: available ? [] : [{ code: "GOOGLE_OAUTH_NOT_CONFIGURED", message: "Google sign-in has not been configured." }] };
    else if (path.endsWith(`/${connector.setup.apiPath}/connections`)) data = { connections: [connection] };
    else if (path.endsWith("/calendar1/calendars")) data = { items: [{ id: "primary", name: "Appointments", timeZone: "Africa/Johannesburg", role: "owner" }] };
    else if (path.endsWith("/calendar1/calendar")) { expect(body.generation).toBe(connection.generation); expect(body.calendarId).toBe("primary"); connection = { ...connection, generation: connection.generation + 1, calendar: { id: "primary", name: "Appointments", timeZone: "Africa/Johannesburg", role: "owner" }, readiness: { state: "ready", reasons: [] } }; data = { connection }; }
    else if (path.endsWith("/calendar1/sharing")) { expect(body.generation).toBe(connection.generation); connection = { ...connection, generation: connection.generation + 1, sharing: body.sharing, customerDeploymentEligible: body.sharing === "organization_service" }; data = { connection }; }
    else if (path.endsWith("/calendar1/disconnect")) { expect(body.generation).toBe(connection.generation); connection = { ...connection, status: "disconnected", generation: connection.generation + 1, customerDeploymentEligible: false }; data = { connection }; }
    else if (path.endsWith("/calendar1/authorize")) { await route.fulfill({ status: 503, json: { error: { message: "Google sign-in is temporarily unavailable." } } }); return; }
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
  await page.getByRole("button", { name: "Allow customer bookings" }).click();
  await expect(page.getByText("Publishing a booking agent still requires", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Allow booking service", exact: true }).click();
  await expect(page.getByText("Shared with the booking service", { exact: false })).toBeVisible();
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
  expect(state.requests[0].path).toBe("/api/organizations/org/calendar-fixture/connections/calendar1/calendar"); expect(state.errors).toEqual([]);
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
