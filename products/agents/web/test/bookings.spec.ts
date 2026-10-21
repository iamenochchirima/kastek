import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { agentSummary } from "./workspace-fixtures";
import type { Configuration } from "../src/platform/api";
const base: Configuration = { executionKind: "business", instructions: "Help customers book appointments.", model: { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free", maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 }, tools: [], capabilities: { delegation: { enabled: false }, sandbox: { enabled: false }, businessActions: { enabled: false }, workflows: { enabled: false }, schedules: { enabled: false } } };

async function fixture(page: Page, mode: "pending" | "expired" | "foreign" | "uncertain" | "conflict" | "claimed" = "pending", recovery?: "confirmed" | "uncertain" | "in_progress") {
  let draft = structuredClone(base), revision = 1;
  let booking = { id: "booking1", taskId: mode === "foreign" ? "private-child" : "root", state: mode === "uncertain" ? "uncertain" : mode === "claimed" ? "claimed" : "pending", start: "2026-11-02T08:00:00Z", end: "2026-11-02T08:30:00Z", timeZone: "Africa/Johannesburg", title: "Consultation <script>", requestDigest: "exact-booking-digest", expiresAt: mode === "expired" ? "2020-01-01T00:00:00Z" : "2035-01-01T00:00:00Z" };
  const reconciles: { path: string; body: unknown }[] = [];
  const decisions: unknown[] = [], policies: unknown[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: "org", name: "Bookings UI fixture", role: "owner" }] };
    else if (path.endsWith("/agents/root/booking-policies")) {
      if (request.method() === "POST") { const body = request.postDataJSON(); expect(body).toMatchObject({ connectionId: "calendar1", title: "Consultation", durationMinutes: 30, minimumNoticeMinutes: 60, maximumAdvanceDays: 30 }); const policy = { id: "policy1", policyDigest: "policy-digest", state: "active", definition: { ...body, timeZone: "Africa/Johannesburg", calendarId: "primary", connectionPolicyRevision: 1 } }; policies.push(policy); data = { policy }; } else data = { policies };
    } else if (path.endsWith("/google-calendar/connections")) data = { connections: [{ id: "calendar1", name: "Clinic", customerDeploymentEligible: true, calendar: { name: "Appointments", timeZone: "Africa/Johannesburg" } }, { id: "private-calendar", name: "Private calendar", customerDeploymentEligible: false, calendar: { name: "Personal", timeZone: "UTC" } }] };
    else if (path.endsWith("/agents/root")) { if (request.method() === "PUT") { draft = request.postDataJSON().configuration; revision++; } data = { agent: { id: "root", name: "Booking assistant", offering: "booking", draft, draftRevision: revision }, versions: [], deployments: [] }; }
    else if (path.endsWith("/agents/root/configuration")) { expect(request.postDataJSON().expectedRevision).toBe(revision); draft = request.postDataJSON().configuration; revision++; data = { agent: { id: "root", name: "Booking assistant", offering: "booking", draft, draftRevision: revision }, snapshot: { id: `snapshot-${revision}`, number: revision, configuration: structuredClone(draft) }, deployments: [] }; }
    else if (path.endsWith("/agents/summaries")) data = { agents: [agentSummary({ id: "root", name: "Booking assistant" })], nextCursor: null };
    else if (path.endsWith("/knowledge/sources")) data = { sources: [], imports: [] };
    else if (path.endsWith("/conversations")) data = { conversations: [], nextCursor: null };
    else if (path.endsWith("/tasks/root")) data = { task: { id: "root", state: booking.state === "pending" ? "waiting_review" : "completed", hasBookings: true, output: null, errorCode: null, conversationId: "conversation" }, operations: [], events: [], actions: [] };
    else if (path.endsWith("/tasks/root/tool-reviews")) data = { reviews: [] };
    else if (path.endsWith("/tasks/root/bookings")) data = { bookings: [booking] };
    else if (path.endsWith("/bookings/booking1/reconcile")) { reconciles.push({ path, body: request.postDataJSON() }); if (recovery === "in_progress") { await route.fulfill({ status: 409, json: { error: { code: "BOOKING_IN_PROGRESS", message: "The appointment is still being processed. Check again shortly." } } }); return; } booking = { ...booking, state: recovery === "uncertain" ? "uncertain" : "confirmed" }; data = { booking }; }
    else if (path.endsWith("/bookings/booking1/decision")) { const body = request.postDataJSON(); decisions.push(body); if (mode === "conflict") { booking = { ...booking, state: "conflict" }; await route.fulfill({ status: 409, json: { error: { message: "The booking changed. Choose another time." } } }); return; } booking = { ...booking, state: body.decision === "approve" ? "confirmed" : "rejected" }; data = { booking }; }
    else { await route.fulfill({ status: 404, json: { error: { message: `Unexpected booking fixture ${path}` } } }); return; }
    await route.fulfill({ json: data });
  });
  return { draft: () => draft, decisions, reconciles, errors };
}

test("mock transport: booking policy creation and exact draft pin are separate explicit actions", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/app/agents/root?section=configuration");
  await page.getByRole("button", { name: "New booking policy" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Booking calendar" }).selectOption("calendar1");
  await expect(dialog).not.toContainText("Private calendar");
  await dialog.getByRole("textbox", { name: "Appointment title" }).fill("Consultation");
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(process.cwd(), `../../../.audit/mock-booking-policy-${width}.png`), fullPage: true, animations: "disabled" });
  }
  await dialog.getByRole("button", { name: "Create policy", exact: true }).click();
  await expect(dialog).toBeHidden(); expect(state.draft().capabilities.businessActions).toEqual({ enabled: false });
  await page.getByRole("combobox", { name: "Booking policy", exact: true }).selectOption("policy1");
  expect(state.draft().capabilities.businessActions).toEqual({ enabled: false });
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect(state.draft().capabilities.businessActions).toEqual({ enabled: true, profileId: "google-calendar-booking-v1", policyId: "policy1", policyDigest: "policy-digest" });
  await page.getByRole("combobox", { name: "Booking policy", exact: true }).selectOption("");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect(state.draft().capabilities.businessActions).toEqual({ enabled: false }); expect(state.errors).toEqual([]);
});

test("mock transport: exact appointment confirmation sends digest after a user confirmation", async ({ page }) => {
  const state = await fixture(page); await page.goto("/app/tasks/root");
  const appointments = page.getByRole("region", { name: "Appointments", exact: true });
  await expect(appointments.getByRole("heading", { name: "Consultation <script>" })).toBeVisible();
  await expect(appointments).toContainText("Africa/Johannesburg");
  await appointments.getByRole("button", { name: "Confirm appointment", exact: true }).click();
  expect(state.decisions).toEqual([]);
  await page.getByRole("alertdialog").getByRole("button", { name: "Confirm appointment", exact: true }).click();
  await expect(appointments.getByText("Appointment booked", { exact: true })).toBeVisible();
  expect(state.decisions).toEqual([{ decision: "approve", requestDigest: "exact-booking-digest" }]); expect(state.errors).toEqual([]);
});
for (const mode of ["expired", "foreign", "uncertain", "conflict"] as const) test(`mock transport: booking ${mode} cannot be silently approved`, async ({ page }) => {
  const state = await fixture(page, mode); await page.goto("/app/tasks/root");
  if (mode === "conflict") { await page.getByRole("button", { name: "Confirm appointment", exact: true }).click(); await page.getByRole("alertdialog").getByRole("button", { name: "Confirm appointment", exact: true }).click(); await expect(page.getByText("The booking changed. Choose another time.")).toBeVisible(); await expect(page.getByText("Time no longer available", { exact: true })).toBeVisible(); }
  else if (mode === "expired") await expect(page.getByText("Confirmation expired", { exact: true })).toBeVisible();
  else if (mode === "uncertain") await expect(page.getByText("Check with the organization before booking again.")).toBeVisible();
  else await expect(page.getByRole("region", { name: "Appointments", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm appointment", exact: true })).toHaveCount(0);
  expect(state.decisions.length).toBe(mode === "conflict" ? 1 : 0);
});


test("mock transport: declining an appointment sends only the exact request digest", async ({ page }) => {
  const state = await fixture(page); await page.goto("/app/tasks/root");
  await page.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(page.getByText("Declined", { exact: true })).toBeVisible();
  expect(state.decisions).toEqual([{ decision: "reject", requestDigest: "exact-booking-digest" }]);
});


for (const recovery of ["confirmed", "uncertain", "in_progress"] as const) test(`mock transport: operator status-only booking recovery returns ${recovery}`, async ({ page }) => {
  const state = await fixture(page, recovery === "in_progress" ? "claimed" : "uncertain", recovery); await page.goto("/app/tasks/root");
  const appointments = page.getByRole("region", { name: "Appointments", exact: true });
  await appointments.getByRole("button", { name: "Check status", exact: true }).click();
  await expect.poll(() => state.reconciles.length).toBe(1);
  expect(state.reconciles).toEqual([{ path: "/api/organizations/org/tasks/root/bookings/booking1/reconcile", body: {} }]); expect(state.decisions).toEqual([]);
  if (recovery === "confirmed") { await expect(appointments.getByText("Appointment booked", { exact: true })).toBeVisible(); await expect(appointments.getByRole("status")).toBeFocused(); }
  else {
    if (recovery === "in_progress") await expect(page.getByText("The appointment is still being processed. Check again shortly.", { exact: true })).toBeVisible();
    await expect(appointments.getByRole("button", { name: "Check status", exact: true })).toBeEnabled();
    await expect(appointments.getByRole("button", { name: "Check status", exact: true })).toBeFocused();
  }
  await expect(appointments.getByRole("button", { name: "Confirm appointment", exact: true })).toHaveCount(0); expect(state.errors).toEqual([]);
});
