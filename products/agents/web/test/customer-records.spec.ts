import { expect, test, type Page } from "@playwright/test";
const timestamp = "2026-10-27T10:00:00.000Z";
async function fixture(
  page: Page,
  role = "owner",
  assigneeAccountId: string | null = null,
) {
  const commands: Record<string, unknown>[] = [];
  let enquiry = {
    id: "enquiry",
    revision: "1",
    status: "new",
    fields: {
      name: "Ada",
      email: "ada@example.test",
      message: "Please call me",
    },
    originalFields: {
      name: "Ada",
      email: "ada@example.test",
      message: "Please call me",
    },
    sourceEnquiryId: "submission",
    sourceTaskId: "task",
    agentId: "agent",
    conversationId: null,
    customerConversationId: "thread",
    contactId: null as string | null,
    assigneeAccountId,
    dueAt: null as string | null,
    createdAt: timestamp,
    updatedAt: timestamp,
    activity: [] as Array<Record<string, unknown>>,
  };
  let contact = {
    id: "contact",
    revision: "1",
    name: "Ada",
    email: "ada@example.test",
    phone: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  await page.route("**/api/**", async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      path = url.pathname,
      body = request.postData() ? request.postDataJSON() : null;
    let data: unknown = {};
    if (path === "/api/session")
      data = {
        account: {
          id: "owner",
          email: "staff@example.test",
          displayName: "Owner",
        },
        organizations: [{ id: "org", name: "Shop", role }],
      };
    else if (path.endsWith("/customer-records/members"))
      data = {
        members: [
          { accountId: "owner", name: "Owner", role },
          { accountId: "staff", name: "Support", role: "member" },
        ],
      };
    else if (path.endsWith("/enquiries/enquiry/commands")) {
      commands.push(body);
      expect(body.expectedRevision).toBe(enquiry.revision);
      enquiry = { ...enquiry, revision: String(Number(enquiry.revision) + 1) };
      if (body.action === "claim") enquiry.assigneeAccountId = "owner";
      if (body.action === "assign")
        enquiry.assigneeAccountId = body.assigneeAccountId;
      if (body.action === "unassign") enquiry.assigneeAccountId = null;
      if (body.action === "set-status") enquiry.status = body.status;
      if (body.action === "reopen") enquiry.status = "new";
      if (body.action === "set-due") enquiry.dueAt = body.dueAt;
      if (body.action === "link-contact") enquiry.contactId = body.contactId;
      if (body.action === "correct") enquiry.fields = body.fields;
      if (body.action === "note")
        enquiry.activity.push({
          id: "note",
          kind: "note",
          actorAccountId: "owner",
          body: body.body,
          createdAt: timestamp,
        });
      data = { enquiry };
    } else if (path.endsWith("/enquiries/enquiry/activity"))
      data = { activity: enquiry.activity, nextCursor: null };
    else if (path.endsWith("/enquiries/enquiry")) data = { enquiry };
    else if (path.endsWith("/customer-records/enquiries"))
      data = {
        enquiries: [enquiry],
        nextCursor: url.searchParams.has("cursor") ? null : "page2",
      };
    else if (path.endsWith("/contacts/contact/commands")) {
      commands.push(body);
      contact = { ...contact, ...body, revision: "2" };
      data = { contact };
    } else if (path.endsWith("/contacts/contact"))
      data = { contact, enquiries: [enquiry] };
    else if (path.endsWith("/customer-records/contacts")) {
      if (body) {
        commands.push(body);
        contact = { ...contact, ...body };
        data = { contact };
      } else data = { contacts: [contact], nextCursor: null };
    }
    await route.fulfill({ json: data });
  });
  return commands;
}
for (const width of [1440, 768, 390])
  test(`customer workspace follow-up at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const commands = await fixture(page);
    await page.goto("/app/customers");
    await page.getByRole("link", { name: /Ada.*New/ }).click();
    await expect(
      page.getByRole("heading", { name: "Ada", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Assign to me" }).click();
    await expect(
      page.getByRole("button", { name: "Unassign me" }),
    ).toBeVisible();
    await page
      .getByLabel("Enquiry status", { exact: true })
      .selectOption("in_progress");
    await expect(
      page.getByLabel("Enquiry status", { exact: true }),
    ).toHaveValue("in_progress");
    await page
      .getByLabel("Internal note", { exact: true })
      .fill("Call after lunch");
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await expect(
      page.getByText("Call after lunch", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Enquiry status", { exact: true })
      .selectOption("closed");
    await page
      .getByRole("button", { name: "Reopen enquiry", exact: true })
      .click();
    await expect(
      page.getByLabel("Enquiry status", { exact: true }),
    ).toHaveValue("new");
    await page
      .getByRole("button", { name: "Edit details", exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByLabel("Name", { exact: true })
      .fill("Ada Lovelace");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Ada Lovelace", exact: true }),
    ).toBeVisible();
    await page.getByText("Original submission", { exact: true }).click();
    await expect(page.getByText("Ada", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Link contact", exact: true })
      .click();
    await page.getByLabel("Contact to link").selectOption("contact");
    await page
      .getByRole("button", { name: "Link contact", exact: true })
      .last()
      .click();
    await expect(
      page.getByRole("button", { name: "Unlink contact" }),
    ).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath(`customer-detail-${width}.png`),
      fullPage: true,
    });
    await page
      .getByRole("region", { name: "Internal activity", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath(`customer-activity-${width}.png`),
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(commands.some((command) => command.action === "note")).toBe(true);
  });
test("contact creation, correction and linked enquiries", async ({ page }) => {
  const commands = await fixture(page);
  await page.goto("/app/customers?view=contacts");
  await page.getByRole("button", { name: "Add contact" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Grace");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await page.getByRole("link", { name: "Grace", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Grace", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit contact", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Phone", { exact: true })
    .fill("+27123456789");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("+27123456789", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: /Please call me/ }),
  ).toBeVisible();
  expect(commands.some((command) => command.action === "correct")).toBe(true);
});
test("filters reset the page and pagination removes duplicates", async ({
  page,
}) => {
  await fixture(page);
  await page.goto("/app/customers");
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Ada.*New/ })).toHaveCount(1);
  await page.getByLabel("Search customers").fill("Ada");
  await page.getByLabel("Filter enquiry status").selectOption("new");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page).toHaveURL(/search=Ada.*status=new/);
  await expect(page.getByRole("button", { name: "Load more" })).toBeVisible();
});
test("unassigned member claims before changing follow-up", async ({ page }) => {
  await fixture(page, "member");
  await page.goto("/app/customers?enquiry=enquiry");
  await expect(
    page.getByLabel("Enquiry status", { exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("button", { name: "Edit details" })).toHaveCount(
    0,
  );
  await page.getByRole("button", { name: "Assign to me" }).click();
  await expect(
    page.getByLabel("Enquiry status", { exact: true }),
  ).toBeEnabled();
  await expect(page.getByLabel("Enquiry assignee")).toBeDisabled();
});
test("uncertain updates retry the identical command", async ({ page }) => {
  await fixture(page);
  const attempted: Record<string, unknown>[] = [];
  let fail = true;
  await page.route(
    "**/customer-records/enquiries/enquiry/commands",
    async (route) => {
      attempted.push(route.request().postDataJSON());
      if (fail) {
        fail = false;
        await route.fulfill({
          status: 503,
          json: { message: "Connection interrupted" },
        });
      } else await route.fallback();
    },
  );
  await page.goto("/app/customers?enquiry=enquiry");
  await page.getByRole("button", { name: "Assign to me" }).click();
  await expect(
    page.getByRole("button", { name: "Retry update" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry update" }).click();
  await expect(page.getByRole("button", { name: "Unassign me" })).toBeVisible();
  expect(attempted[1]).toEqual(attempted[0]);
});
test("uncertain contact creation preserves the request on retry", async ({
  page,
}) => {
  await fixture(page);
  const attempted: Record<string, unknown>[] = [];
  let fail = true;
  await page.route("**/customer-records/contacts", async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    attempted.push(route.request().postDataJSON());
    if (fail) {
      fail = false;
      await route.fulfill({
        status: 503,
        json: { message: "Connection interrupted" },
      });
    } else await route.fallback();
  });
  await page.goto("/app/customers?view=contacts");
  await page.getByRole("button", { name: "Add contact" }).click();
  await page
    .getByRole("dialog")
    .getByLabel("Name", { exact: true })
    .fill("Grace");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByRole("dialog").getByLabel("Name", { exact: true }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Retry save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(attempted[1]).toEqual(attempted[0]);
});

test("revoked assignee remains distinct from unassigned", async ({ page }) => {
  await fixture(page, "owner", "former-staff");
  await page.goto("/app/customers");
  await expect(page.getByText("Former member", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: /Ada.*New/ }).click();
  const assignee = page.getByLabel("Enquiry assignee");
  await expect(assignee).toHaveValue("former-staff");
  await expect(assignee.locator("option:checked")).toHaveText("Former member");
  await expect(assignee.locator("option:checked")).toHaveAttribute("disabled", "");
  await expect(page.getByRole("button", { name: "Assign to me" })).toHaveCount(
    0,
  );
  await assignee.selectOption("staff");
  await expect(assignee).toHaveValue("staff");
});
