import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import type { ToolReview } from "../src/platform/api";

async function fixture(page: Page, mode: "pending" | "expired" | "foreign" | "conflict" | "uncertain" | "completed" = "pending", argumentData?: unknown) {
  let review: ToolReview = { id: "review1", taskId: "root", rootTaskId: "root", operationId: "operation1", operationName: "send_message", connectionName: "Team workspace", destination: "https://workspace.example.test/mcp", effect: "reviewed_write", bindingId: "binding1", bindingDigest: "binding-digest", requestDigest: "exact-request-digest", arguments: argumentData === undefined ? { channel: "support", message: "Reply <img src=x onerror=alert(1)> to the customer.", recipients: ["Support team"] } : argumentData, connectionId: "connection1", reviewerAccountId: "owner", state: mode === "uncertain" ? "uncertain" : mode === "completed" ? "completed" : "pending", expiresAt: mode === "expired" ? "2020-01-01T00:00:00Z" : "2035-01-01T00:00:00Z" };
  const decisions: unknown[] = [], reviewPaths: string[] = [], errors: string[] = [];
  let approvedPolls = 0, denied = false;
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: "org", name: "Review tests", role: "owner" }] };
    else if (path.endsWith("/tasks/root")) data = { canControl: false, task: { id: "root", state: ["completed", "rejected"].includes(review.state) ? "completed" : "waiting_review", hasToolReviews: true, output: null, errorCode: null, conversationId: "conversation", input: "Send an approved support response." }, operations: [], actions: [], events: [] };
    else if (path.endsWith("/tasks/root/tool-reviews")) {
      reviewPaths.push(path);
      if (denied) { await route.fulfill({ status: 403, json: { error: { message: "Review access removed" } } }); return; }
      if (review.state === "approved" && ++approvedPolls >= 2) review = { ...review, state: "completed" };
      data = { reviews: mode === "foreign" ? [{ ...review, taskId: "private-child", arguments: { private: "Hidden child arguments" } }, { ...review, id: "other-reviewer", reviewerAccountId: "other", arguments: { private: "Hidden reviewer arguments" } }] : [review] };
    } else if (path.endsWith("/tool-reviews/review1/decision")) {
      const body = request.postDataJSON(); decisions.push(body);
      if (mode === "conflict") { review = { ...review, state: "invalidated" }; await route.fulfill({ status: 409, json: { error: { message: "The action changed. Request another review." } } }); return; }
      expect(body).toEqual({ decision: body.decision, requestDigest: "exact-request-digest" });
      review = { ...review, state: body.decision === "approve" ? "approved" : "rejected" }; data = { review };
    } else { await route.fulfill({ status: 404, json: { error: { message: `Unexpected approval mock route ${path}` } } }); return; }
    await route.fulfill({ json: data });
  });
  return { decisions, reviewPaths, errors, deny: () => { denied = true; } };
}

for (const width of [1440, 768, 390]) {
  test(`mock transport: exact tool approval requires confirmation and follows completion at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await fixture(page);
    await page.goto("/app/tasks/root");
    const approvals = page.getByRole("region", { name: "Tool approvals", exact: true });
    await expect(approvals.getByRole("heading", { name: "send message", exact: true })).toBeVisible();
    await expect(approvals.getByText("Team workspace", { exact: true })).toBeVisible();
    await expect(approvals.getByText("Reply <img src=x onerror=alert(1)> to the customer.", { exact: true })).toBeVisible();
    await expect(approvals.locator("img")).toHaveCount(0);
    await approvals.getByText("Exact data", { exact: true }).click();
    await expect(approvals.locator("pre")).toContainText('"recipients"');
    await expect(approvals).not.toContainText("exact-request-digest");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(process.cwd(), `../../../.audit/mock-tool-approval-${width}.png`), fullPage: true, animations: "disabled" });
    await approvals.getByRole("button", { name: "Approve action", exact: true }).click();
    expect(state.decisions).toEqual([]);
    await page.getByRole("alertdialog").getByRole("button", { name: "Cancel", exact: true }).click();
    expect(state.decisions).toEqual([]);
    await approvals.getByRole("button", { name: "Approve action", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Approve action", exact: true }).click();
    await expect(approvals.getByText("Completed", { exact: true })).toBeVisible();
    expect(state.decisions).toEqual([{ decision: "approve", requestDigest: "exact-request-digest" }]);
    expect(state.reviewPaths.every(path => path === "/api/organizations/org/tasks/root/tool-reviews")).toBe(true);
    expect(state.errors).toEqual([]);
  });
}

test("mock transport: rejecting a tool action sends only its exact request digest", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/app/tasks/root");
  await page.getByRole("button", { name: "Reject action", exact: true }).click();
  await expect(page.getByRole("region", { name: "Tool approvals" }).getByText("Rejected", { exact: true })).toBeVisible();
  expect(state.decisions).toEqual([{ decision: "reject", requestDigest: "exact-request-digest" }]);
});

test("mock transport: expired approvals remain inspectable and cannot be decided", async ({ page }) => {
  const state = await fixture(page, "expired");
  await page.goto("/app/tasks/root");
  const approvals = page.getByRole("region", { name: "Tool approvals" });
  await expect(approvals.getByText("Expired", { exact: true })).toBeVisible();
  await expect(approvals.getByRole("button", { name: "Approve action", exact: true })).toBeDisabled();
  await expect(approvals.getByRole("button", { name: "Reject action", exact: true })).toBeDisabled();
  expect(state.decisions).toEqual([]);
});

test("mock transport: other reviewers and private child arguments never enter this task view", async ({ page }) => {
  const state = await fixture(page, "foreign");
  await page.goto("/app/tasks/root");
  await expect.poll(() => state.reviewPaths.length).toBeGreaterThan(0);
  await expect(page.getByRole("region", { name: "Tool approvals" })).toHaveCount(0);
  await expect(page.getByText(/Hidden child arguments|Hidden reviewer arguments/)).toHaveCount(0);
  expect(state.decisions).toEqual([]);
});

test("mock transport: revoked review access clears arguments from the view", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/app/tasks/root");
  const approvals = page.getByRole("region", { name: "Tool approvals" });
  await expect(approvals.getByText("Team workspace", { exact: true })).toBeVisible();
  state.deny();
  await approvals.getByRole("button", { name: "Refresh approvals", exact: true }).click();
  await expect(approvals.getByRole("alert")).toContainText("Review access removed");
  await expect(approvals.getByText("Team workspace", { exact: true })).toHaveCount(0);
  await expect(approvals.getByRole("button", { name: "Approve action", exact: true })).toHaveCount(0);
});

test("mock transport: changed arguments invalidate the old decision", async ({ page }) => {
  const state = await fixture(page, "conflict");
  await page.goto("/app/tasks/root");
  const approvals = page.getByRole("region", { name: "Tool approvals" });
  await approvals.getByRole("button", { name: "Approve action", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Approve action", exact: true }).click();
  await expect(approvals.getByRole("alert")).toContainText("The action changed");
  await expect(approvals.getByText("No longer valid", { exact: true })).toBeVisible();
  await expect(approvals.getByRole("button", { name: "Approve action", exact: true })).toHaveCount(0);
  expect(state.decisions).toHaveLength(1);
});

test("mock transport: uncertain writes offer status refresh without a retry action", async ({ page }) => {
  const state = await fixture(page, "uncertain");
  await page.goto("/app/tasks/root");
  const approvals = page.getByRole("region", { name: "Tool approvals" });
  await expect(approvals.getByText("Outcome unknown", { exact: true })).toBeVisible();
  await expect(approvals.getByRole("button", { name: /Approve|Reject|Retry/ })).toHaveCount(0);
  await expect(approvals.getByRole("button", { name: "Refresh approvals", exact: true })).toBeVisible();
  expect(state.decisions).toEqual([]);
});

test("mock transport: completed task reload uses the authorized review presence flag", async ({ page }) => {
  await fixture(page, "completed");
  await page.goto("/app/tasks/root");
  const approvals = page.getByRole("region", { name: "Tool approvals" });
  await expect(approvals.getByText("Completed", { exact: true })).toBeVisible();
  await approvals.getByText("Exact data", { exact: true }).click();
  await expect(approvals.locator("pre")).toContainText('"channel": "support"');
  await expect(approvals.getByRole("button", { name: "Approve action", exact: true })).toHaveCount(0);
});


test("mock transport: null tool arguments remain inspectable without a rendering failure", async ({ page }) => {
  const state = await fixture(page, "pending", null);
  await page.goto("/app/tasks/root");
  const approvals = page.getByRole("region", { name: "Tool approvals" });
  await expect(approvals.getByText("None", { exact: true })).toBeVisible();
  await approvals.getByText("Exact data", { exact: true }).click();
  await expect(approvals.locator("pre")).toHaveText("null");
  expect(state.errors).toEqual([]);
});
