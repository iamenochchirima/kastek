import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";

type Fixture = { url: string; organizationId: string; agentId: string; otherAgentId: string; bookingAgentId: string; bookingTaskId: string; bookingRequestDigest: string; cookie: string };
type AgentResponse = { agent: { draft: { skillIds: string[]; tools: string[] }; draftRevision: number }; versions: { id: string; number: number; configuration: { skillIds: string[] } }[] };
const fixturePath = process.env.AGENTS_CATALOGUE_BROWSER_STATE;
test.skip(!fixturePath, "Run through the isolated actual API catalogue browser fixture");

async function currentAgent(page: Page, fixture: Fixture, agentId = fixture.agentId) {
  const response = await page.request.get(`${fixture.url}/api/organizations/${fixture.organizationId}/agents/${agentId}`);
  expect(response.status()).toBe(200); return response.json() as Promise<AgentResponse>;
}

test("actual API: curated and private skill revisions survive save, reload and immutable publication", async ({ page, context }) => {
  const fixture: Fixture = JSON.parse(await readFile(fixturePath!, "utf8"));
  await context.addCookies([{ name: "agents_session", value: fixture.cookie, url: fixture.url, httpOnly: true, sameSite: "Lax" }]);
  const errors: string[] = [], failures: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (new URL(response.url()).pathname.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  const agentPath = `${fixture.url}/app/agents/${fixture.agentId}`;
  await page.goto(`${agentPath}?section=tools`);
  const tools = page.getByRole("region", { name: "Tools catalogue", exact: true });
  await expect(tools.getByRole("heading", { name: "Human support", exact: true })).toBeVisible();
  await expect(tools.getByRole("button", { name: "Remove Human support", exact: true })).toBeVisible();
  await tools.getByRole("button", { name: "Remove Human support", exact: true }).click();
  expect((await currentAgent(page, fixture)).agent.draft.tools).toContain("channel.request_handoff");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect((await currentAgent(page, fixture)).agent.draft.tools).not.toContain("channel.request_handoff");
  await tools.getByRole("button", { name: "Add Human support", exact: true }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await page.getByRole("combobox", { name: "Library", exact: true }).selectOption("curated");
  const catalogue = page.getByRole("region", { name: "Skills catalogue", exact: true });
  const curatedName = "grounded-answers";
  await catalogue.getByRole("button", { name: `Add ${curatedName}`, exact: true }).click();
  const preview = page.getByRole("dialog");
  await expect(preview.getByRole("heading", { name: curatedName, exact: true })).toBeVisible();
  await expect(preview.locator("pre")).not.toBeEmpty();
  const installResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/skills/curated/grounded-answers/install") && response.request().method() === "POST");
  await preview.getByRole("button", { name: "Add skill", exact: true }).click();
  const installed = (await (await installResponse).json()).package;
  expect(installed.id).toMatch(/^[0-9a-f-]{36}$/); expect(installed.reviewState).toBe("reviewed"); expect(installed.publisher.verified).toBe(true);
  expect((await currentAgent(page, fixture)).agent.draft.skillIds).toEqual([]);
  await expect(page.getByRole("button", { name: "Create version", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect((await currentAgent(page, fixture)).agent.draft.skillIds).toEqual([installed.id]);
  await page.reload();
  await catalogue.getByRole("button", { name: "Added 1", exact: true }).click();
  await expect(catalogue.getByRole("button", { name: `Remove ${curatedName}`, exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Import skill", exact: true }).click();
  await page.getByLabel("Skill file", { exact: true }).setInputFiles({ name: "SKILL.md", mimeType: "text/markdown", buffer: Buffer.from("---\nname: acceptance-replies\ndescription: Write concise support replies.\n---\nWrite clearly. Cite approved sources and ask for clarification when needed.") });
  const importResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/skills/packages") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const imported = (await (await importResponse).json()).package;
  expect(imported.reviewState).toBe("pending"); expect(imported.publisher.verified).toBe(false);
  await expect(preview.getByRole("heading", { name: "acceptance-replies", exact: true })).toBeVisible();
  await expect(preview.locator("pre")).toContainText("Write clearly.");
  const reviewResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/skills/packages/${imported.id}/review`));
  await preview.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  const review = await reviewResponse;
  expect(review.request().postDataJSON()).toEqual({ contentDigest: imported.contentDigest });
  expect((await review.json()).package.reviewState).toBe("reviewed");
  await preview.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(page.getByRole("combobox", { name: "Library", exact: true })).toHaveValue("private");
  await catalogue.getByRole("button", { name: "Add acceptance-replies", exact: true }).click();
  expect((await currentAgent(page, fixture)).agent.draft.skillIds).toEqual([installed.id]);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  const expectedIds = [installed.id, imported.id];
  expect((await currentAgent(page, fixture)).agent.draft.skillIds).toEqual(expectedIds);
  const published = await currentAgent(page, fixture);
  expect(published.versions.length).toBeGreaterThan(0); expect(published.versions[0]!.configuration.skillIds).toEqual(expectedIds);
  await page.reload();
  await catalogue.getByRole("button", { name: "Added 2", exact: true }).click();
  await expect(catalogue.getByRole("article")).toHaveCount(2);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(process.cwd(), `../../../.audit/actual-api-skills-${width}.png`), fullPage: true, animations: "disabled" });
  }
  await catalogue.getByRole("button", { name: "Remove acceptance-replies", exact: true }).click();
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  const changed = await currentAgent(page, fixture);
  expect(changed.agent.draft.skillIds).toEqual([installed.id]); expect(changed.versions[0]!.configuration.skillIds).toEqual([installed.id]); expect(published.versions[0]!.configuration.skillIds).toEqual(expectedIds);
  expect((await currentAgent(page, fixture, fixture.otherAgentId)).agent.draft.skillIds).toEqual([]);
  await page.goto(`${fixture.url}/app/agents/${fixture.otherAgentId}?section=skills`);
  await page.getByRole("combobox", { name: "Library", exact: true }).selectOption("private");
  await expect(page.getByRole("button", { name: "Add acceptance-replies", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]); expect(failures).toEqual([]);
});

test("actual API: native API operations, private credentials and immutable bindings persist through reload", async ({ page, context }) => {
  const fixture: Fixture = JSON.parse(await readFile(fixturePath!, "utf8"));
  await context.addCookies([{ name: "agents_session", value: fixture.cookie, url: fixture.url, httpOnly: true, sameSite: "Lax" }]);
  const errors: string[] = [], failures: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (new URL(response.url()).pathname.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  const source = { openapi: "3.1.0", info: { title: "Acceptance inventory", version: "1" }, servers: [{ url: "https://api.example.com/v1" }], security: [{ serviceKey: [] }], components: { securitySchemes: { serviceKey: { type: "apiKey", in: "header", name: "X-API-Key" } } }, paths: {
    "/items": { get: { operationId: "list_items", summary: "List inventory", parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }], responses: { "200": { description: "Inventory", content: { "application/json": { schema: { type: "object", properties: { items: { type: "array", items: { type: "string" } } }, additionalProperties: false } } } } } },
      post: { operationId: "create_item", summary: "Create inventory item", requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { title: { type: "string" } }, required: ["title"], additionalProperties: false } } } }, responses: { "201": { description: "Created", content: { "application/json": { schema: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false } } } } } } },
  } };
  await page.goto(`${fixture.url}/app/connections?profile=custom-api`);
  let dialog = page.getByRole("dialog");
  await dialog.getByLabel("Server URL", { exact: true }).fill("https://api.example.com/v1");
  await dialog.getByLabel("OpenAPI document", { exact: true }).fill(JSON.stringify(source, null, 2));
  await dialog.getByRole("button", { name: "Preview operations", exact: true }).click();
  await dialog.getByRole("checkbox", { name: /List inventory/ }).check();
  await dialog.getByRole("checkbox", { name: /Create inventory item/ }).check();
  await dialog.getByLabel("X-API-Key", { exact: true }).fill("isolated-browser-credential");
  const importedResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/api-connections") && response.request().method() === "POST");
  const selectionResponse = page.waitForResponse(response => /\/api-connections\/[^/]+\/operations$/.test(new URL(response.url()).pathname) && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Save connection", exact: true }).click();
  const imported = (await (await importedResponse).json()).connection;
  const selected = await (await selectionResponse).json();
  expect(imported).not.toHaveProperty("credentials"); expect(imported.credentialSchemes[0].configured).toBe(true);
  expect(selected.connection.selectedOperationIds).toHaveLength(2); expect(selected.bindings).toHaveLength(2);
  expect(selected.bindings.every((binding: { transport: string; policy: { approval: string } }) => binding.transport === "native_http" && binding.policy.approval === "exact_single_use")).toBe(true);
  await expect(dialog).toBeHidden();
  await page.goto(`${fixture.url}/app/connections`); await page.reload();
  const connections = page.getByRole("region", { name: "Custom API connections", exact: true });
  await expect(connections.getByRole("heading", { name: "Acceptance inventory", exact: true })).toBeVisible();
  await connections.getByRole("button", { name: "Manage operations", exact: true }).click(); dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("checkbox", { name: /List inventory/ })).toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: /Create inventory item/ })).toBeChecked();
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(process.cwd(), `../../../.audit/actual-api-native-operations-${width}.png`), fullPage: true, animations: "disabled" });
  }
  await dialog.getByRole("button", { name: "Replace credentials", exact: true }).click();
  await expect(dialog.getByLabel("X-API-Key", { exact: true })).toHaveValue("");
  await dialog.getByLabel("X-API-Key", { exact: true }).fill("isolated-browser-replacement");
  await dialog.getByRole("button", { name: "Replace credentials", exact: true }).click();
  await expect(dialog.getByRole("checkbox", { name: /List inventory/ })).not.toBeChecked();
  await expect(dialog.getByRole("checkbox", { name: /Create inventory item/ })).not.toBeChecked();
  await dialog.getByRole("checkbox", { name: /List inventory/ }).check();
  await dialog.getByRole("button", { name: "Save operations", exact: true }).click();
  await expect(dialog).toBeHidden();
  const current = await page.request.get(`${fixture.url}/api/organizations/${fixture.organizationId}/api-connections/${imported.id}`);
  expect(current.status()).toBe(200);
  const result = (await current.json()).connection;
  expect(result.selectedOperationIds).toHaveLength(1); expect(result.bindingIds).toHaveLength(1); expect(result.policyRevision).toBeGreaterThan(selected.connection.policyRevision);
  expect(JSON.stringify(result)).not.toContain("isolated-browser-");
  expect(await page.evaluate(() => Object.values(sessionStorage).some(value => value.includes("isolated-browser-")))).toBe(false);
  await connections.getByRole("button", { name: "Disconnect", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Disconnect", exact: true }).click();
  await expect(connections.getByText("Disconnected · 1 selected", { exact: true })).toBeVisible();
  expect(errors).toEqual([]); expect(failures).toEqual([]);
});

test("actual API: skill revision comparison and owner lifecycle persist exact packages", async ({ page, context }) => {
  const fixture: Fixture = JSON.parse(await readFile(fixturePath!, "utf8"));
  await context.addCookies([{ name: "agents_session", value: fixture.cookie, url: fixture.url, httpOnly: true, sameSite: "Lax" }]);
  const errors: string[] = [], failures: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (new URL(response.url()).pathname.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  const path = `${fixture.url}/api/organizations/${fixture.organizationId}/agents/${fixture.otherAgentId}/skills/packages`;
  const packages = [];
  for (const body of ["First reviewed instructions.", "Updated reviewed instructions."]) {
    const response = await page.request.post(path, { headers: { Origin: new URL(fixture.url).origin }, data: { operationId: crypto.randomUUID(), files: [{ path: "SKILL.md", content: `---\nname: lifecycle-replies\ndescription: Review revision lifecycle.\n---\n${body}` }] } });
    expect(response.status()).toBe(200); const skill = (await response.json()).package; packages.push(skill);
    const review = await page.request.post(`${path}/${skill.id}/review`, { headers: { Origin: new URL(fixture.url).origin }, data: { contentDigest: skill.contentDigest } }); expect(review.status()).toBe(200);
  }
  expect(packages[0].familyId).toMatch(/^[a-f0-9]{64}$/); expect(packages[1].familyId).toBe(packages[0].familyId);
  await page.goto(`${fixture.url}/app/agents/${fixture.otherAgentId}?section=skills`);
  await page.getByRole("button", { name: "Available", exact: true }).click();
  await page.getByRole("button", { name: "lifecycle-replies", exact: true }).first().click();
  const dialog = page.getByRole("dialog").first();
  await dialog.getByText("Compare revisions", { exact: true }).click();
  const options = dialog.getByRole("combobox", { name: "Compare revision" });
  const candidateId = await options.locator("option").nth(1).getAttribute("value");
  await options.selectOption(candidateId!); await dialog.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(dialog.getByText("SKILL.md · changed", { exact: false })).toBeVisible();
  await expect(dialog.getByText("First reviewed instructions.", { exact: false }).last()).toBeVisible();
  await expect(dialog.getByText("Updated reviewed instructions.", { exact: false }).last()).toBeVisible();
  await dialog.getByRole("button", { name: "Disable skill", exact: true }).click();
  await page.getByRole("button", { name: "Disable skill", exact: true }).last().click();
  await expect(dialog.getByRole("button", { name: "Enable skill", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Enable skill", exact: true }).click();
  await page.getByRole("button", { name: "Enable skill", exact: true }).last().click();
  await expect(dialog.getByRole("button", { name: "Disable skill", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Remove skill", exact: true }).click();
  await page.getByRole("button", { name: "Remove skill", exact: true }).last().click();
  await expect(dialog.getByText(/Revision .* · removed/)).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Enable skill", exact: true })).toHaveCount(0);
  expect((await currentAgent(page, fixture, fixture.otherAgentId)).agent.draft.skillIds).toEqual([]);
  expect(errors).toEqual([]); expect(failures).toEqual([]);
});


test("actual API with controlled Google provider: sign-in, calendar sharing and explicit booking policy", async ({ page, context }) => {
  const fixture: Fixture = JSON.parse(await readFile(fixturePath!, "utf8"));
  await context.addCookies([{ name: "agents_session", value: fixture.cookie, url: fixture.url, httpOnly: true, sameSite: "Lax" }]);
  const errors: string[] = [], failures: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (new URL(response.url()).pathname.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  // Only the external authorization navigation is simulated. KasiTek APIs and Google HTTP fixture calls are real.
  await page.route("https://accounts.fixture.test/authorize?*", async route => {
    const callback = new URL("/api/google-calendar/callback", fixture.url);
    callback.searchParams.set("state", new URL(route.request().url()).searchParams.get("state")!); callback.searchParams.set("code", "controlled-fixture");
    await route.fulfill({ status: 302, headers: { location: callback.href }, body: "" });
  });
  await page.goto(`${fixture.url}/app/connections?profile=google-calendar-v1`);
  await page.getByRole("textbox", { name: "Connection name", exact: true }).fill("Acceptance appointments");
  const createResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/google-calendar/connections") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Connect Google account", exact: true }).click();
  const connection = (await (await createResponse).json()).connection;
  await page.waitForURL(url => url.pathname === "/app/connections" && url.searchParams.get("setupStatus") === "connected");
  const row = page.getByRole("heading", { name: "Acceptance appointments", exact: true }).locator("..");
  await expect(row).toContainText("Private");
  await row.getByRole("button", { name: "Choose calendar", exact: true }).click();
  const calendar = page.getByRole("combobox", { name: "Calendar", exact: true });
  await calendar.selectOption({ label: "Appointments · Africa/Johannesburg · owner" });
  await page.getByRole("button", { name: "Save calendar", exact: true }).click();
  await row.getByRole("button", { name: "Allow customer bookings", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Allow booking service", exact: true }).click();
  await expect(row).toContainText("Shared with the booking service");
  await page.reload(); await expect(row).toContainText("Acceptance appointments"); await expect(row).toContainText("Africa/Johannesburg");
  await page.goto(`${fixture.url}/app/agents/${fixture.bookingAgentId}?section=configuration`);
  await page.getByRole("button", { name: "New booking policy", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Booking calendar", exact: true }).selectOption(connection.id);
  await dialog.getByRole("textbox", { name: "Appointment title", exact: true }).fill("Browser consultation");
  const policyResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/booking-policies") && response.request().method() === "POST");
  await dialog.getByRole("button", { name: "Create policy", exact: true }).click();
  const policy = (await (await policyResponse).json()).policy;
  expect(policy.definition.timeZone).toBe("Africa/Johannesburg"); expect(policy.definition.connectionId).toBe(connection.id);
  const before = await (await page.request.get(`${fixture.url}/api/organizations/${fixture.organizationId}/agents/${fixture.bookingAgentId}`)).json();
  expect(before.agent.draft.capabilities.businessActions).toEqual({ enabled: false });
  await page.getByRole("combobox", { name: "Booking policy", exact: true }).selectOption(policy.id);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await page.reload(); await expect(page.getByRole("combobox", { name: "Booking policy", exact: true })).toHaveValue(policy.id);
  const saved = await (await page.request.get(`${fixture.url}/api/organizations/${fixture.organizationId}/agents/${fixture.bookingAgentId}`)).json();
  expect(saved.agent.draft.capabilities.businessActions).toEqual({ enabled: true, profileId: "calendar-booking-v1", permittedOperations:["calendar.availability","calendar.book"], policyId: policy.id, policyDigest: policy.policyDigest });
  expect(errors).toEqual([]); expect(failures).toEqual([]);
});

test("actual API with controlled Google provider: exact task appointment requires explicit confirmation", async ({ page, context }) => {
  const fixture: Fixture = JSON.parse(await readFile(fixturePath!, "utf8"));
  await context.addCookies([{ name: "agents_session", value: fixture.cookie, url: fixture.url, httpOnly: true, sameSite: "Lax" }]);
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${fixture.url}/app/tasks/${fixture.bookingTaskId}`);
  const appointments = page.getByRole("region", { name: "Appointments", exact: true });
  await expect(appointments.getByRole("heading", { name: "Consultation", exact: true })).toBeVisible();
  await expect(appointments).toContainText("Africa/Johannesburg");
  await appointments.getByRole("button", { name: "Confirm appointment", exact: true }).click();
  const decision = page.waitForResponse(response => new URL(response.url()).pathname.includes(`/tasks/${fixture.bookingTaskId}/bookings/`) && response.request().method() === "POST");
  await page.getByRole("alertdialog").getByRole("button", { name: "Confirm appointment", exact: true }).click();
  const response = await decision; expect(response.status()).toBe(200);
  expect(response.request().postDataJSON()).toEqual({ decision: "approve", requestDigest: fixture.bookingRequestDigest });
  expect((await response.json()).booking.state).toBe("approved");
  await expect(appointments.getByText("Confirmed by you", { exact: true })).toBeVisible();
  await page.reload(); await expect(appointments.getByText("Confirmed by you", { exact: true })).toBeVisible();
  await expect(appointments.getByRole("button", { name: "Confirm appointment", exact: true })).toHaveCount(0);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(process.cwd(), `../../../.audit/actual-api-booking-confirmation-${width}.png`), fullPage: true, animations: "disabled" });
  }
  expect(errors).toEqual([]);
});
