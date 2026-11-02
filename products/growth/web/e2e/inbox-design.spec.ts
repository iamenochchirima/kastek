import { expect, test, type Page } from "@playwright/test";

const channelNames = ["All conversations", "WhatsApp", "Email", "SMS", "Instagram", "Messenger"];
const customerRow = (page: Page) => page.getByRole("button", { name: /^Fixture customer/ }).first();
const channels = (page: Page) => page.getByRole("tablist", { name: "Inbox channels" });

async function expectChannels(page: Page) {
  await expect(channels(page).getByRole("tab")).toHaveCount(6);
  for (const name of channelNames) {
    await expect(channels(page).getByRole("tab", { name, exact: true })).toBeVisible();
  }
}

test("keeps every channel tab available while switching channels", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/inbox");
  await expectChannels(page);

  const sms = channels(page).getByRole("tab", { name: "SMS", exact: true });
  await expect(sms).toHaveAttribute("aria-disabled", "true");
  await sms.click({ force: true });
  await expect(channels(page).getByRole("tab", { name: "All conversations", exact: true })).toHaveAttribute("aria-selected", "true");

  await channels(page).getByRole("tab", { name: "All conversations", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(channels(page).getByRole("tab", { name: "WhatsApp", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(channels(page).getByRole("tab", { name: "Messenger", exact: true })).toHaveAttribute("aria-selected", "true");

  for (const name of ["WhatsApp", "Email", "Instagram", "Messenger", "All conversations"]) {
    const tab = channels(page).getByRole("tab", { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
    await expectChannels(page);
  }
  await expect(customerRow(page)).toBeVisible();
});

test("searches conversations and applies unread and starred filters", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/inbox");
  await expect(customerRow(page)).toBeVisible();
  const search = page.getByPlaceholder("Search conversations...");
  await search.fill("does-not-match-any-customer");
  await expect(customerRow(page)).toHaveCount(0);
  await search.fill("fixture customer");
  await expect(customerRow(page)).toBeVisible();
  await search.fill("");

  const filters = page.locator('[aria-label="Conversation filters"]');
  for (const name of ["Unread", "Starred"]) {
    await filters.getByRole("button", { name, exact: true }).click();
    await expect(customerRow(page)).toHaveCount(0);
    await filters.getByRole("button", { name: "All", exact: true }).click();
    await expect(customerRow(page)).toBeVisible();
  }
});

test("opens contact details and returns to the conversation list on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/inbox");
  await customerRow(page).click();
  await expect(page.getByRole("textbox", { name: "Reply message", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Contact details", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Contact details", exact: true });
  await expect(details).toBeVisible();
  await expect(details.getByText("+27720001111", { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(details).toBeHidden();
  await page.getByRole("button", { name: "Back to conversations", exact: true }).click();
  await expect(customerRow(page)).toBeVisible();
  await expect(page.getByPlaceholder("Search conversations...")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("persists an accessible composer reply through the controlled API", async ({ page, request }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(() => localStorage.setItem("kasitek-theme", "dark"));
  await page.goto("/inbox?conversation=fixture-inbox");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  const contact = page.getByRole("complementary", { name: "Contact details", exact: true });
  await expect(contact.getByText("+27720001111", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open Growth assistant", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message", exact: true })).toHaveText("Send");
  const composer = page.getByRole("textbox", { name: "Reply message", exact: true });
  const reply = "Inbox design persisted reply";
  await composer.fill(reply);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(composer).toHaveValue("");
  await page.reload();
  await expect(page.getByText(reply, { exact: true }).first()).toBeVisible();
  const response = await request.get("http://127.0.0.1:4311/__fixture/migration");
  expect(response.ok()).toBe(true);
  const state = await response.json();
  expect(state.inboxMessages.some((message: { text: string; status: string }) => message.text === reply && message.status === "SENT")).toBe(true);
});


test("keeps message controls keyboard accessible and receipts below bubbles", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/inbox?conversation=fixture-inbox");
  const stack = page.locator(".inbox-message-stack").first();
  const bubble = stack.locator(".inbox-message-bubble");
  const receipt = stack.locator(".inbox-message-meta");
  await expect(bubble).toBeVisible();
  const bubbleBounds = await bubble.boundingBox();
  const receiptBounds = await receipt.boundingBox();
  expect(bubbleBounds).not.toBeNull();
  expect(receiptBounds).not.toBeNull();
  expect(receiptBounds!.y).toBeGreaterThanOrEqual(bubbleBounds!.y + bubbleBounds!.height);

  const actions = stack.getByRole("button", { name: "Message actions", exact: true });
  await actions.focus();
  await expect(stack.locator(".inbox-message-actions")).toHaveCSS("opacity", "1");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Reply", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(actions).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
