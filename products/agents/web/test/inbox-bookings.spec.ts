import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import type { BookingConfirmation } from "../src/platform/api";

async function fixture(page: Page, options: { noBookings?: boolean; delayed?: boolean; delayedRecovery?: boolean; recovery?: "confirmed" | "uncertain" | "in_progress" } = {}) {
  const now = "2026-10-20T08:00:00Z";
  const conversations = ["a", "b"].map(id => ({ id: `conv-${id}`, agentId: "agent", agentName: `Conversation ${id.toUpperCase()}`, deploymentId: "deployment", versionId: "version", channel: "website", state: "handoff_pending", assigneeAccountId: "owner", revision: "1", ownershipGeneration: "1", createdAt: now, updatedAt: now }));
  const booking = (id: string): BookingConfirmation => ({ id: `booking-${id}`, taskId: `task-${id}`, state: "uncertain", title: `Appointment ${id.toUpperCase()}`, start: "2026-11-02T08:00:00Z", end: "2026-11-02T08:30:00Z", timeZone: "Africa/Johannesburg", requestDigest: `digest-${id}`, expiresAt: "2035-01-01T00:00:00Z" });
  const records = { a: booking("a"), b: booking("b") }, reads: string[] = [], writes: { path: string; body: unknown }[] = [], errors: string[] = [];
  let details = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    if (request.method() === "POST") writes.push({ path, body: request.postDataJSON() });
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: "org", name: "Inbox booking tests", role: "owner" }] };
    else if (path.endsWith("/agents/summaries")) data = { agents: [{ id: "agent", name: "Appointments" }], nextCursor: null };
    else if (path.endsWith("/inbox/members")) data = { members: [{ id: "owner", displayName: "Owner" }] };
    else if (path.endsWith("/inbox")) data = { conversations, nextCursor: null };
    else if (/\/inbox\/conv-[ab]$/.test(path)) { const id = path.endsWith("conv-a") ? 0 : 1; details++; data = { conversation: { ...conversations[id], hasBookings: !options.noBookings }, messages: [{ id: "message", sequence: "1", authorKind: "visitor", body: `Help with ${conversations[id].agentName}`, createdAt: now }], nextSequence: "1", latestSequence: "1" }; }
    else if (/\/inbox\/conv-[ab]\/bookings$/.test(path)) { reads.push(path); const id = path.includes("conv-a") ? "a" : "b"; const snapshot = structuredClone(records[id]); if (options.delayed && id === "a") await gate; data = { bookings: [snapshot] }; }
    else if (/\/inbox\/conv-[ab]\/bookings\/booking-[ab]\/reconcile$/.test(path)) { const id = path.includes("conv-a") ? "a" : "b"; expect(path).toContain(`/conv-${id}/bookings/booking-${id}/`); if (options.delayedRecovery) await gate; if (options.recovery === "in_progress") { await route.fulfill({ status: 409, json: { error: { code: "BOOKING_IN_PROGRESS", message: "Appointment processing is still in progress." } } }); return; } records[id] = { ...records[id], state: options.recovery === "uncertain" ? "uncertain" : "confirmed" }; data = { booking: records[id] }; }
    else { await route.fulfill({ status: 404, json: { error: { message: `Unexpected Inbox fixture ${path}` } } }); return; }
    await route.fulfill({ json: data });
  });
  await page.goto("/app/inbox");
  return { reads, writes, errors, release, details: () => details };
}
for (const width of [1440, 768, 390]) test(`mock transport: staff appointment status has no customer decision controls at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 }); const state = await fixture(page);
  await page.getByRole("button", { name: "Conversation A", exact: false }).click(); await page.getByRole("button", { name: "Details", exact: true }).click();
  const appointments = page.getByRole("region", { name: "Staff appointments", exact: true });
  await expect(appointments.getByRole("heading", { name: "Appointment A", exact: true })).toBeVisible();
  await expect(appointments).toContainText("Africa/Johannesburg");
  await expect(page.getByRole("button", { name: /Confirm appointment|Decline|Book appointment/ })).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(test.info().config.rootDir, `../../../../.audit/mock-inbox-bookings-${width}.png`), fullPage: true, animations: "disabled" });
  await appointments.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(appointments.getByText("Appointment booked", { exact: true })).toBeVisible(); await expect(appointments.getByRole("status")).toBeFocused();
  expect(state.writes).toEqual([{ path: "/api/organizations/org/inbox/conv-a/bookings/booking-a/reconcile", body: {} }]); expect(state.errors).toEqual([]);
});

test("mock transport: FAQ Inbox details never fetch unrelated booking records", async ({ page }) => {
  const state = await fixture(page, { noBookings: true }); await page.getByRole("button", { name: "Conversation A", exact: false }).click(); await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect(page.getByText("Help with Conversation A", { exact: true })).toBeVisible();
  await expect.poll(state.details).toBeGreaterThan(1); expect(state.reads).toEqual([]);
  await expect(page.getByRole("region", { name: "Staff appointments", exact: true })).toHaveCount(0);
});

test("mock transport: delayed booking reads cannot replace another Inbox conversation", async ({ page }) => {
  const state = await fixture(page, { delayed: true }); await page.getByRole("button", { name: "Conversation A", exact: false }).click(); await page.getByRole("button", { name: "Details", exact: true }).click();
  await expect.poll(() => state.reads.length).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Conversation B", exact: false }).click();
  const appointments = page.getByRole("region", { name: "Staff appointments", exact: true });
  await expect(appointments.getByRole("heading", { name: "Appointment B", exact: true })).toBeVisible(); state.release();
  await expect.poll(state.details).toBeGreaterThan(2);
  await expect(appointments.getByRole("heading", { name: "Appointment A", exact: true })).toHaveCount(0);
  await appointments.getByRole("button", { name: "Check status", exact: true }).click();
  await expect(appointments.getByText("Appointment booked", { exact: true })).toBeVisible();
  expect(state.writes[0].path).toBe("/api/organizations/org/inbox/conv-b/bookings/booking-b/reconcile");
});
for (const recovery of ["uncertain", "in_progress"] as const) test(`mock transport: staff recovery ${recovery} offers status only`, async ({ page }) => {
  const state = await fixture(page, { recovery }); await page.getByRole("button", { name: "Conversation A", exact: false }).click(); await page.getByRole("button", { name: "Details", exact: true }).click();
  const appointments = page.getByRole("region", { name: "Staff appointments", exact: true });
  await appointments.getByRole("button", { name: "Check status", exact: true }).click();
  await expect.poll(() => state.writes.length).toBe(1);
  if (recovery === "in_progress") await expect(appointments.getByText("Appointment processing is still in progress.", { exact: true })).toBeVisible();
  await expect(appointments.getByRole("button", { name: "Check status", exact: true })).toBeEnabled();
  await expect(appointments.getByRole("button", { name: "Check status", exact: true })).toBeFocused();
  expect(state.writes[0].path).toMatch(/\/reconcile$/); await expect(page.getByRole("button", { name: /Confirm appointment|Decline|Book appointment/ })).toHaveCount(0);
});


test("mock transport: late staff status recovery cannot update a newly selected conversation", async ({ page }) => {
  const state = await fixture(page, { delayedRecovery: true }); await page.getByRole("button", { name: "Conversation A", exact: false }).click(); await page.getByRole("button", { name: "Details", exact: true }).click();
  const appointments = page.getByRole("region", { name: "Staff appointments", exact: true });
  await appointments.getByRole("button", { name: "Check status", exact: true }).click(); await expect.poll(() => state.writes.length).toBe(1);
  await page.getByRole("button", { name: "Conversation B", exact: false }).click();
  await expect(appointments.getByRole("heading", { name: "Appointment B", exact: true })).toBeVisible(); state.release();
  await expect.poll(state.details).toBeGreaterThan(2);
  await expect(appointments.getByText("Booking outcome unknown", { exact: true })).toBeVisible();
  await expect(appointments.getByRole("heading", { name: "Appointment A", exact: true })).toHaveCount(0);
  await expect(appointments.getByText("Appointment booked", { exact: true })).toHaveCount(0);
  expect(state.writes).toEqual([{ path: "/api/organizations/org/inbox/conv-a/bookings/booking-a/reconcile", body: {} }]);
});
