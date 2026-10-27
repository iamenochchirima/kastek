import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";

async function controlledContacts(page: Page) {
  await page.route("**/api/whatsapp/contacts?*", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const original = body.contacts[0];
    body.contacts = [
      { ...original, id: "contact-beta", fullName: "Beta contact", phone: "+27720001111", createdAt: "2025-01-01T00:00:00Z", metadata: { department: "Sales" } },
      { ...original, id: "contact-alice", fullName: 'Alice, "North"', phone: "+27720002222", createdAt: "2026-01-01T00:00:00Z", metadata: { department: "Research\nNorth" } },
    ];
    body.lists[0].metadataKeys = ["department"];
    body.lists[0].totalContacts = 2;
    body.stats = { totalContacts: 2, optedInContacts: 2, excludedContacts: 0, filteredTotal: 2 };
    await route.fulfill({ response, json: body });
  });
}

test("sorts the current page and toggles actual field columns", async ({ page }) => {
  await controlledContacts(page);
  await page.goto("/contacts?listLabel=Migration%20list");
  const table = page.getByRole("region", { name: "Contacts table", exact: true });
  await page.getByRole("combobox", { name: "Sort current page", exact: true }).click();
  await page.getByRole("option", { name: "Name · this page", exact: true }).click();
  await page.getByRole("button", { name: "Sort current page ascending", exact: true }).click();
  await expect(table.getByRole("row").nth(1)).toContainText('Alice, "North"');
  await page.getByRole("combobox", { name: "Sort current page", exact: true }).click();
  await page.getByRole("option", { name: "Phone · this page", exact: true }).click();
  await expect(table.getByRole("row").nth(1)).toContainText("Beta contact");
  await page.getByRole("combobox", { name: "Sort current page", exact: true }).click();
  await page.getByRole("option", { name: "Added · this page", exact: true }).click();
  await expect(table.getByRole("row").nth(1)).toContainText("Beta contact");
  await page.getByRole("button", { name: "Sort current page descending", exact: true }).click();
  await expect(table.getByRole("row").nth(1)).toContainText('Alice, "North"');

  await page.getByRole("button", { name: "Columns", exact: true }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Contact", exact: true })).toBeDisabled();
  await page.getByRole("menuitemcheckbox", { name: "Phone", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "department", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(table.getByRole("columnheader", { name: "Phone", exact: true })).toHaveCount(0);
  await expect(table.getByRole("columnheader", { name: "department", exact: true })).toHaveCount(0);
  await expect(table.getByRole("columnheader", { name: "Contact", exact: true })).toBeVisible();
});

test("exports only selected page records with CSV escaping", async ({ page }) => {
  await controlledContacts(page);
  await page.goto("/contacts?listLabel=Migration%20list");
  await page.getByRole("checkbox", { name: 'Select contact Alice, "North"', exact: true }).check();
  await expect(page.getByText("1 selected on this page", { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export selected CSV", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("selected-contacts.csv");
  const path = await download.path();
  expect(path).not.toBeNull();
  const csv = await readFile(path!, "utf8");
  expect(csv).toContain('"Alice, ""North"""');
  expect(csv).toContain('"Research\nNorth"');
  expect(csv).not.toContain("Beta contact");
  await page.getByRole("checkbox", { name: "Select contacts on this page", exact: true }).check();
  await expect(page.getByText("2 selected on this page", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Select contacts on this page", exact: true })).not.toBeChecked();
});

test("adds one contact through the existing import contract with explicit consent", async ({ page }) => {
  let submitted = "";
  await page.route("**/api/whatsapp/contacts/import", async route => {
    submitted = route.request().postData() || "";
    await route.fulfill({ status: 200, json: { summary: { created: 1, updated: 0, invalidRows: 0 } } });
  });
  await page.goto("/contacts");
  await page.getByRole("button", { name: "Add contact", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add contact", exact: true });
  await dialog.getByRole("textbox", { name: "Full name", exact: true }).fill("New fixture contact");
  await dialog.getByRole("textbox", { name: "Phone", exact: true }).fill("+27720003333");
  await dialog.getByRole("checkbox", { name: "Opted in to marketing", exact: true }).check();
  await expect(dialog.getByRole("button", { name: "Save contact", exact: true })).toBeDisabled();
  await dialog.getByRole("checkbox", { name: "I have permission to record this marketing consent.", exact: true }).check();
  await dialog.getByRole("button", { name: "Save contact", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Contact saved.", { exact: true })).toBeVisible();
  expect(submitted).toContain('name="consentConfirmed"\r\n\r\ntrue');
  expect(submitted).toContain('"+27720003333","New fixture contact"');
});
