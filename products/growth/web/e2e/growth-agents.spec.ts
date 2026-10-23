import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
  await context.addCookies([{ name: "kasitek_active_org", value: "growth-fixture-one", domain: "127.0.0.1", path: "/" }]);
});

test("uses one conversation from quick access, full page and history", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Your agents" })).toBeVisible();
  await expect(page.getByText("Approved sources required")).toBeVisible();
  await page.screenshot({ path: "../../../.audit/growth-agents-overview-desktop.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "Open Growth assistant", exact: true }).click();
  const chat = page.getByRole("region", { name: "Agent conversation" });
  await expect(chat.getByText("What should we work on?", { exact: true })).toBeVisible();
  await page.screenshot({ path: "../../../.audit/growth-agents-assistant-desktop.png", fullPage: true, animations: "disabled" });
  await chat.getByRole("textbox", { name: "Message agent" }).fill("Help me prioritize this week");
  await chat.getByRole("button", { name: "Send message" }).click();
  await expect(chat.getByText("I reviewed the business context. Here is the next step for your work.", { exact: true })).toBeVisible();
  await chat.getByRole("link", { name: "Expand conversation" }).click();
  await expect(page).toHaveURL(/\/agents\/conversations\//);
  await page.reload();
  await expect(page.getByRole("paragraph").filter({ hasText: /^Help me prioritize this week$/ })).toBeVisible();
  await page.getByRole("link", { name: "Agents", exact: true }).last().click();
  await page.getByRole("tab", { name: "Conversations", exact: true }).click();
  await page.getByRole("textbox", { name: "Search conversations" }).fill("prioritize");
  await expect(page.getByRole("link", { name: /Help me prioritize this week/ })).toBeVisible();
});

test("retries a lost acknowledgement with the same request identity", async ({ page, request }) => {
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Growth assistant Guidance/ }).click();
  await page.getByRole("textbox", { name: "Message agent" }).fill("lost response for safe retry");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(page.getByRole("button", { name: "Retry message" })).toBeVisible();
  await page.getByRole("button", { name: "Retry message" }).click();
  await expect(page.getByRole("button", { name: "Retry message" })).toHaveCount(0);
  const state = await (await request.get("http://127.0.0.1:4310/__fixture/attempts")).json();
  const attempts = state.attempts.filter((attempt: { text: string }) => attempt.text === "lost response for safe retry");
  expect(attempts).toHaveLength(2);
  expect(attempts[0].requestId).toBe(attempts[1].requestId);
});

test("shows the saved-record receipt after editing the exact proposal", async ({ page }) => {
  await page.goto("/agents");
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await page.getByRole("button", { name: /Content Draft and improve/ }).click();
  await page.getByRole("textbox", { name: "Message agent" }).fill("Prepare a draft for review");
  await page.getByRole("button", { name: "Send message" }).click();
  const review = page.getByRole("region", { name: "Draft review" });
  await expect(review).toBeVisible();
  await review.getByRole("button", { name: "Edit", exact: true }).click();
  await review.getByRole("textbox", { name: "Content", exact: true }).fill("Updated weekend offer for our customers.");
  await expect(review.getByRole("button", { name: "Save draft", exact: true })).toHaveCount(0);
  await review.getByRole("button", { name: "Update proposal" }).click();
  await review.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(review.getByRole("link", { name: "Open draft", exact: true })).toHaveAttribute("href", "/content/posts/saved-fixture-draft");
});

for (const width of [768, 390]) test(`supports keyboard and full-screen chat at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/agents");
  await page.getByRole("button", { name: "Open Growth assistant", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Growth assistant", exact: true });
  await expect(dialog).toBeVisible();
  await page.screenshot({ path: `../../../.audit/growth-agents-assistant-${width}.png`, fullPage: true, animations: "disabled" });
  expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  const bounds = await dialog.boundingBox();
  expect(bounds?.width).toBeLessThanOrEqual(width);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("clears previous business content before loading another business", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/agents");
  await page.getByRole("button", { name: "Open Growth assistant", exact: true }).click();
  await expect(page.getByRole("region", { name: "Agent conversation" })).toBeVisible();
  await page.getByRole("button", { name: "Luma Studio", exact: false }).first().click();
  await page.getByRole("menuitem", { name: "Another business", exact: false }).click();
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  await expect(page.getByText("Second business conversation", { exact: true })).toBeVisible();
  await expect(page.getByText("What should we work on?", { exact: true })).toHaveCount(0);
});

test("rejects foreign and forwarded origins when switching business", async ({ request }) => {
  const response = await request.post("/api/orgs/set-active", { headers: { origin: "https://untrusted.example", "x-forwarded-host": "untrusted.example", "x-forwarded-proto": "https" }, data: { orgId: "growth-fixture-two" } });
  expect(response.status()).toBe(403);
  const spoofed = await request.post("/api/orgs/set-active", { headers: { origin: "http://127.0.0.1:3310", host: "untrusted.example" }, data: { orgId: "growth-fixture-two" } });
  expect(spoofed.status()).toBe(403);
});
