import { expect, test, type Page } from "@playwright/test";

const base = "/api/organizations/org";

type Setup = {
  business: { name: string; website: string; description: string };
  responsibilities: string[];
  channels: string[];
  behaviour: { agentName: string; language: string; tone: string; handoffInstructions: string };
};

async function fixture(page: Page) {
  const requests: { path: string; method: string; body: Record<string, unknown> }[] = [];
  let revision = 1;
  let setup: Setup | null = null;
  let setupStep: string | null = null;
  let name = "";
  const agent = () => ({
    id: "wizard-agent",
    name,
    setup,
    setupStep,
    draftRevision: revision,
    draft: {
      executionKind: "business",
      instructions: "",
      model: { selection: { kind: "organization_default" } },
      tools: [],
      sourceRevisionIds: [],
      capabilities: { businessActions: { enabled: false }, delegation: { enabled: false }, sandbox: { enabled: false }, workflows: { enabled: false }, schedules: { enabled: false } },
    },
  });
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? request.postDataJSON() : null;
    if (body) requests.push({ path, method: request.method(), body });
    let data: unknown = {};
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test" }, organizations: [{ id: "org", name: "Business", role: "owner" }] };
    else if (path.endsWith("/agents/summaries")) data = { agents: [], nextCursor: null };
    else if (path.endsWith("/inbox-alerts")) data = { unread: 0, alerts: [] };
    else if (path === `${base}/agents` && request.method() === "POST") {
      name = String(body.name);
      setup = body.setup as Setup;
      revision = 1;
      data = { agent: agent() };
    } else if (path === `${base}/agents/wizard-agent`) data = { agent: agent(), deployments: [], versions: [] };
    else if (path === `${base}/agents/wizard-agent/configuration`) {
      expect(body.expectedRevision).toBe(revision);
      name = String(body.name);
      setup = (body.setup as Setup) ?? setup;
      setupStep = String(body.setupStep);
      revision++;
      data = { agent: agent(), deployments: [], snapshot: { id: "version", number: 1 } };
    } else if (path.endsWith("/website-crawls")) data = { crawls: [], available: false };
    else if (path === `${base}/knowledge/sources`) data = { sources: [], imports: [] };
    else if (path.endsWith("/setup-readiness")) data = { readiness: { readyToTest: false, setupStep, requirements: { model: { state: "ready", code: null }, bookings: { state: "deferred", code: null } }, channels: [] } };
    else if (path.endsWith("/model-providers/default")) data = { selection: null, revision: 0 };
    else if (path.endsWith("/model-providers")) data = { connections: [] };
    else if (path.endsWith("/conversations")) data = { conversations: [], nextCursor: null };
    await route.fulfill({ json: data });
  });
  return requests;
}

async function openWizard(page: Page) {
  await page.goto("/app/agents");
  await page.getByRole("button", { name: "Create agent", exact: true }).filter({ visible: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Create agent", exact: true });
  await expect(dialog.getByRole("heading", { name: "Create agent" })).toBeVisible();
  return dialog;
}

async function named(page: Page, value: string) {
  const dialog = await openWizard(page);
  await dialog.getByRole("textbox", { name: "Name" }).fill(value);
  await dialog.getByRole("button", { name: "Continue" }).click();
  return dialog;
}

test("template creation asks only for a name, job and knowledge", async ({ page }) => {
  const requests = await fixture(page);
  const dialog = await named(page, "Template agent");
  await expect(dialog.getByText("Step 2 of 4")).toBeVisible();
  await expect(dialog.getByText("Purpose", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: /^Answer questions/ }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByText("Step 3 of 4")).toBeVisible();
  await expect(dialog.getByText("Website crawling is unavailable.")).toBeVisible();
  await dialog.getByRole("button", { name: "Skip for now" }).click();
  await expect(dialog.getByText("Step 4 of 4")).toBeVisible();
  await expect(dialog.getByText("Skipped", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Create agent" }).click();
  await expect(page).toHaveURL(/\/app\/agents\/wizard-agent\?section=capabilities$/u);
  const created = requests.find(request => request.method === "POST" && request.path === `${base}/agents`);
  expect(created?.body).toMatchObject({ name: "Template agent", operationId: expect.any(String) });
  expect(created?.body).not.toHaveProperty("purpose");
  expect(created?.body).not.toHaveProperty("instructions");
  const setup = created?.body.setup as Setup;
  expect(setup.responsibilities).toEqual(["answer-questions"]);
  expect(setup.business.name).toBe("Template agent");
  expect(setup.channels).toEqual([]);
});

test("bookings has no knowledge step and finishes in three steps", async ({ page }) => {
  await fixture(page);
  const dialog = await named(page, "Bookings agent");
  await dialog.getByRole("button", { name: /^Bookings/ }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByText("Step 3 of 3")).toBeVisible();
  await expect(dialog.getByText("Not required", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Create agent" }).click();
  await expect(page).toHaveURL(/\/app\/agents\/wizard-agent\?section=capabilities$/u);
});

test("custom jobs drive setup and skip knowledge when none need it", async ({ page }) => {
  const requests = await fixture(page);
  const dialog = await named(page, "Custom agent");
  await dialog.getByRole("button", { name: /^Custom Choose/ }).click();
  await dialog.getByRole("checkbox", { name: "Answer questions" }).uncheck();
  await dialog.getByRole("checkbox", { name: "Bookings" }).check();
  await dialog.getByRole("checkbox", { name: "Enquiries" }).check();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByText("Step 3 of 3")).toBeVisible();
  await dialog.getByRole("button", { name: "Create agent" }).click();
  await expect(page).toHaveURL(/\/app\/agents\/wizard-agent\?section=capabilities$/u);
  const created = requests.find(request => request.method === "POST" && request.path === `${base}/agents`);
  expect((created?.body.setup as Setup).responsibilities).toEqual(["bookings", "enquiries"]);
});

test("custom can add knowledge without a knowledge job", async ({ page }) => {
  await fixture(page);
  const dialog = await named(page, "Knowledge custom");
  await dialog.getByRole("button", { name: /^Custom Choose/ }).click();
  await dialog.getByRole("checkbox", { name: "Answer questions" }).uncheck();
  await dialog.getByRole("checkbox", { name: "Bookings" }).check();
  await dialog.getByRole("checkbox", { name: "Add knowledge" }).check();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByText("Step 3 of 4")).toBeVisible();
  await dialog.getByRole("button", { name: "Skip for now" }).click();
  await expect(dialog.getByText("Skipped", { exact: true })).toBeVisible();
});

test("closing at knowledge resumes the same draft at knowledge", async ({ page }) => {
  const requests = await fixture(page);
  const dialog = await named(page, "Resumed agent");
  await dialog.getByRole("button", { name: /^Answer questions/ }).click();
  await dialog.getByRole("button", { name: "Continue" }).click();
  await expect(dialog.getByText("Step 3 of 4")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
  const reopened = await openWizard(page);
  await expect(reopened.getByText("Step 3 of 4")).toBeVisible();
  await expect(reopened.getByRole("button", { name: "Skip for now" })).toBeVisible();
  expect(requests.filter(request => request.method === "POST" && request.path === `${base}/agents`)).toHaveLength(1);
  await reopened.getByRole("button", { name: "Skip for now" }).click();
  await expect(reopened.getByText("Resumed agent")).toBeVisible();
  await reopened.getByRole("button", { name: "Create agent" }).click();
  await expect(page).toHaveURL(/\/app\/agents\/wizard-agent\?section=capabilities$/u);
});
