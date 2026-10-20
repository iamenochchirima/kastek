import { createServer, type Server } from "node:http";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";
import { websiteWidgetScript } from "../../api/src/adapters/channels/website/widget";

// Real generated embed script over HTTP. Public API responses are controlled fixtures.
const servers: Server[] = [];
test.afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
type State = "pending" | "approved" | "claimed" | "confirmed" | "rejected" | "expired" | "conflict" | "uncertain";
async function fixture(page: Page, options: { enabled?: boolean; state?: State; expired?: boolean; decision?: "conflict" | "uncertain"; reconcile?: "confirmed" | "uncertain" | "in_progress" } = {}) {
  const deployment = "deployment-exact", conversationId = "conversation-exact", bookingId = "booking-exact";
  let booking = { id: bookingId, state: options.state ?? "pending", start: "2026-11-02T08:00:00Z", end: "2026-11-02T08:30:00Z", timeZone: "Africa/Johannesburg", title: "Consultation <img src=x onerror=alert(1)>", requestDigest: "exact-request-digest", expiresAt: options.expired ? "2020-01-01T00:00:00Z" : "2035-01-01T00:00:00Z" };
  const decisions: { path: string; body: unknown; authorization: string | undefined }[] = [], errors: string[] = [], unexpected: string[] = [];
  const reconciles: { path: string; body: unknown }[] = [];
  let messageReads = 0, bookingReads = 0;
  page.on("pageerror", error => errors.push(error.message));
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, "http://fixture.test").pathname;
    response.setHeader("content-type", "application/json");
    if (path === "/") { response.setHeader("content-type", "text/html; charset=utf-8"); response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><h1>Booking widget fixture</h1><script src="/api/website/deployment-exact/widget.js"></script></body></html>'); return; }
    if (path.endsWith("/widget.js")) { response.setHeader("content-type", "application/javascript; charset=utf-8"); response.end(websiteWidgetScript(deployment)); return; }
    let data: unknown;
    if (path === `/api/website/${deployment}`) data = { name: "Appointment assistant", bookingEnabled: options.enabled !== false };
    else if (path.endsWith("/session")) data = { token: "controlled-widget-token" };
    else if (path.endsWith("/customer-conversations")) data = { conversation: { id: conversationId } };
    else if (path === `/api/website/${deployment}/customer-conversations/${conversationId}/messages`) { messageReads++; data = { conversation: { id: conversationId, state: "automation_active" }, messages: [{ authorKind: "assistant", body: "Choose an appointment when you are ready." }] }; }
    else if (path === `/api/website/${deployment}/customer-conversations/${conversationId}/bookings`) { bookingReads++; data = { bookings: [booking] }; }
    else if (path === `/api/website/${deployment}/customer-conversations/${conversationId}/bookings/${bookingId}/reconcile` && request.method === "POST") {
      let text = ""; for await (const part of request) text += part;
      reconciles.push({ path, body: JSON.parse(text) });
      if (options.reconcile === "in_progress") { response.statusCode = 409; data = { error: { code: "BOOKING_IN_PROGRESS", message: "The appointment is still being processed. Check again shortly." } }; }
      else { booking = { ...booking, state: options.reconcile === "uncertain" ? "uncertain" : "confirmed" }; data = { booking }; }
    }
    else if (path === `/api/website/${deployment}/customer-conversations/${conversationId}/bookings/${bookingId}/decision` && request.method === "POST") {
      let text = ""; for await (const part of request) text += part;
      const body = JSON.parse(text); decisions.push({ path, body, authorization: request.headers.authorization });
      if (options.decision === "conflict") { booking = { ...booking, state: "conflict" }; response.statusCode = 409; data = { error: { message: "This appointment is no longer available." } }; }
      else { booking = { ...booking, state: body.decision === "reject" ? "rejected" : options.decision === "uncertain" ? "uncertain" : "approved" }; data = { booking }; }
    } else if (path === "/favicon.ico") { response.statusCode = 204; response.end(); return; }
    else { unexpected.push(path); response.statusCode = 404; data = { error: { message: "Unexpected controlled widget path" } }; }
    response.end(JSON.stringify(data));
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await page.goto(origin); await page.getByRole("button", { name: "Chat", exact: true }).click();
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  return { decisions, reconciles, errors, unexpected, reads: () => messageReads, bookingReads: () => bookingReads, change: () => { booking = { ...booking, requestDigest: "replacement-request-digest", title: "Changed appointment", start: "2026-11-03T08:00:00Z", end: "2026-11-03T08:30:00Z" }; } };
}

for (const width of [1440, 768, 390]) test(`controlled API: generated widget exact two-step confirmation and stable polling at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  const state = await fixture(page);
  await expect(page.getByText("Consultation <img src=x onerror=alert(1)>", { exact: true })).toBeVisible();
  expect(await page.locator("img").count()).toBe(0);
  const message = page.getByRole("textbox", { name: "Message", exact: true });
  await message.fill("Draft question"); await message.focus(); const before = state.reads();
  await expect.poll(state.reads).toBeGreaterThan(before);
  await expect(message).toBeFocused(); await expect(message).toHaveValue("Draft question");
  await page.getByRole("button", { name: "Confirm appointment", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Confirm appointment", exact: true });
  const yes = dialog.getByRole("button", { name: "Book appointment", exact: true });
  await expect(yes).toBeFocused(); expect(state.decisions).toEqual([]);
  const opened = state.reads(); await expect.poll(state.reads).toBeGreaterThan(opened);
  await expect(dialog).toBeVisible(); await expect(yes).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: resolve(test.info().config.rootDir, `../../../../.audit/controlled-widget-booking-${width}.png`), fullPage: true, animations: "disabled" });
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await expect(page.getByRole("button", { name: "Confirm appointment", exact: true })).toBeFocused(); expect(state.decisions).toEqual([]);
  await page.getByRole("button", { name: "Confirm appointment", exact: true }).click(); await yes.press("Escape");
  await expect(dialog).toHaveCount(0); expect(state.decisions).toEqual([]);
  await page.getByRole("button", { name: "Confirm appointment", exact: true }).click(); await yes.click();
  await expect(page.getByText("Confirming appointment", { exact: true })).toBeVisible();
  expect(state.decisions).toEqual([{ path: "/api/website/deployment-exact/customer-conversations/conversation-exact/bookings/booking-exact/decision", body: { decision: "approve", requestDigest: "exact-request-digest" }, authorization: "Bearer controlled-widget-token" }]);
  expect(state.errors).toEqual([]); expect(state.unexpected).toEqual([]);
});

test("controlled API: generated FAQ widget never fetches booking records", async ({ page }) => {
  const state = await fixture(page, { enabled: false });
  const before = state.reads(); await expect.poll(state.reads).toBeGreaterThan(before);
  expect(state.bookingReads()).toBe(0); await expect(page.getByRole("button", { name: "Confirm appointment", exact: true })).toHaveCount(0);
});

test("controlled API: generated widget decline sends the exact proposal digest", async ({ page }) => {
  const state = await fixture(page); await page.getByRole("button", { name: "Decline", exact: true }).click();
  await expect(page.getByText("Appointment declined", { exact: true })).toBeVisible();
  expect(state.decisions[0].body).toEqual({ decision: "reject", requestDigest: "exact-request-digest" });
});

for (const [state, label] of [["expired", "Appointment proposal expired"], ["conflict", "This time is no longer available"], ["uncertain", "Confirmation pending. Please contact support."]] as const) test(`controlled API: generated widget ${state} has no approval action`, async ({ page }) => {
  const fixtureState = await fixture(page, { state }); await expect(page.getByText(label, { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm appointment", exact: true })).toHaveCount(0); expect(fixtureState.decisions).toEqual([]);
});

test("controlled API: generated widget expires a pending proposal using its deadline", async ({ page }) => {
  const state = await fixture(page, { expired: true }); await expect(page.getByText("Appointment proposal expired", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm appointment", exact: true })).toHaveCount(0); expect(state.decisions).toEqual([]);
});

test("controlled API: generated widget replaces a changed proposal before confirming", async ({ page }) => {
  const state = await fixture(page); await page.getByRole("button", { name: "Confirm appointment", exact: true }).click(); state.change();
  await expect(page.getByText("Changed appointment", { exact: true })).toBeVisible();
  await expect(page.getByRole("dialog", { name: "Confirm appointment", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Confirm appointment", exact: true }).click(); await page.getByRole("button", { name: "Book appointment", exact: true }).click();
  await expect.poll(() => state.decisions.length).toBe(1); expect(state.decisions[0].body).toEqual({ decision: "approve", requestDigest: "replacement-request-digest" });
});

for (const decision of ["conflict", "uncertain"] as const) test(`controlled API: generated widget shows ${decision} after an exact confirmation`, async ({ page }) => {
  const state = await fixture(page, { decision }); await page.getByRole("button", { name: "Confirm appointment", exact: true }).click(); await page.getByRole("button", { name: "Book appointment", exact: true }).click();
  await expect(page.getByText(decision === "conflict" ? "This time is no longer available" : "Confirmation pending. Please contact support.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Confirm appointment", exact: true })).toHaveCount(0); expect(state.decisions).toHaveLength(1);
});

test("controlled API: generated widget rechecks expiry before posting an open confirmation", async ({ page }) => {
  await page.clock.install();
  const state = await fixture(page); await page.getByRole("button", { name: "Confirm appointment", exact: true }).click();
  await page.clock.setFixedTime(new Date("2036-01-01T00:00:00Z"));
  await page.getByRole("button", { name: "Book appointment", exact: true }).click();
  await expect(page.getByText("Appointment proposal expired", { exact: true })).toBeVisible(); expect(state.decisions).toEqual([]);
});


for (const reconcile of ["confirmed", "uncertain", "in_progress"] as const) test(`controlled API: generated widget status-only recovery returns ${reconcile}`, async ({ page }) => {
  const state = await fixture(page, { state: reconcile === "in_progress" ? "claimed" : "uncertain", reconcile });
  await page.getByRole("button", { name: "Check status", exact: true }).click();
  await expect.poll(() => state.reconciles.length).toBe(1);
  expect(state.reconciles).toEqual([{ path: "/api/website/deployment-exact/customer-conversations/conversation-exact/bookings/booking-exact/reconcile", body: {} }]);
  expect(state.decisions).toEqual([]);
  if (reconcile === "confirmed") { await expect(page.getByText("Appointment confirmed", { exact: true })).toBeVisible(); await expect(page.getByRole("status").filter({ hasText: "Appointment confirmed" })).toBeFocused(); }
  else {
    if (reconcile === "in_progress") await expect(page.getByText("The appointment is still being processed. Check again shortly.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Check status", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Check status", exact: true })).toBeFocused();
  }
  await expect(page.getByRole("button", { name: "Confirm appointment", exact: true })).toHaveCount(0);
});
