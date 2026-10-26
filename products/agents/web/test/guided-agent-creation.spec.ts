import { expect, test, type Page } from "@playwright/test";
const base = "/api/organizations/org";
async function fixture(page: Page) {
  const requests: { path: string; body: Record<string, unknown> }[] = [];
  let draftRevision = 1;
  const configuration = { executionKind: "business", instructions: "Support customers", model: { selection: { kind: "organization_default" } }, tools: ["knowledge.search", "knowledge.read"], sourceRevisionIds: ["existing-source"], capabilities: {} };
  const agent = () => ({ id: "new-agent", name: "Bicycle shop assistant", draft: configuration, draftRevision });
  await page.route("**/api/**", async route => {
    const req = route.request(), path = new URL(req.url()).pathname;
    const body = req.postData() ? req.postDataJSON() : null;
    if (body) requests.push({ path, body });
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test" }, organizations: [{ id: "org", name: "Business", role: "owner" }] };
    else if (path.endsWith("/agents/summaries")) data = { agents: [], nextCursor: null };
    else if (path === `${base}/agents` && req.method() === "POST") data = { agent: agent() };
    else if (path.endsWith("/website-crawls")) data = { crawls: [], available: true };
    else if (path.endsWith("/configuration")) { draftRevision++; data = { agent: agent(), deployments: [], snapshot: { id: "version", number: 1, configuration } }; }
    else if (path === `${base}/agents/new-agent`) data = { agent: agent(), deployments: [], versions: [] };
    else if (path.endsWith("/conversations")) data = { conversations: [], nextCursor: null };
    else if (path.endsWith("/model-providers/default")) data = { selection: null, revision: 0 };
    else if (path.endsWith("/model-providers")) data = { connections: [] };
    else data = {};
    await route.fulfill({ json: data });
  });
  return requests;
}
async function start(page: Page) {
  await page.goto("/app/agents");
  if ((page.viewportSize()?.width ?? 1440) <= 640) await page.getByRole("button", { name: "Agents & history", exact: true }).click();
  await page.getByRole("button", { name: "Create agent", exact: true }).filter({ visible: true }).click();
  return page.getByRole("dialog", { name: "Create agent", exact: true });
}
for (const width of [1440, 768, 390]) test(`guided setup preserves choices and knowledge at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 }); const requests = await fixture(page); const dialog = await start(page);
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Enter your business name.");
  await dialog.getByLabel("Business name", { exact: true }).fill("Bicycle shop");
  await dialog.getByLabel("Website (optional)").fill("bicycles.example");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByLabel(/Book appointments/).check();
  await dialog.getByLabel(/Collect enquiries/).check();
  await page.screenshot({ path: test.info().outputPath(`responsibilities-${width}.png`), fullPage: true });
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByLabel("Business website", { exact: true })).toHaveValue("bicycles.example");
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  expect(requests.filter(request => request.path === `${base}/agents`)).toHaveLength(1);
  await dialog.getByRole("button", { name: "Skip for now", exact: true }).click();
  await dialog.getByLabel("WhatsApp", { exact: true }).check();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByLabel("Agent name", { exact: true }).fill("Cycle helper");
  await dialog.getByLabel("Duration (minutes)").fill("45");
  await dialog.getByLabel("Availability and booking rules").fill("Weekdays, 9–5");
  await dialog.getByLabel("Phone", { exact: true }).check();
  await page.screenshot({ path: test.info().outputPath(`preferences-${width}.png`), fullPage: true });
  expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog).toContainText("Channels still need connecting.");
  await page.screenshot({ path: test.info().outputPath(`review-${width}.png`), fullPage: true });
  await dialog.getByRole("button", { name: "Create and test", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/agents\/new-agent$/);
  const saved = requests.find(request => request.path.endsWith("/configuration"))!.body;
  expect(saved.name).toBe("Cycle helper");
  expect(saved.configuration).toEqual(expect.objectContaining({ sourceRevisionIds: ["existing-source"] }));
  expect(saved.setup).toEqual(expect.objectContaining({ responsibilities: ["answer-questions", "customer-support", "bookings", "enquiries"], channels: ["website", "whatsapp"], booking: { durationMinutes: 45, notes: "Weekdays, 9–5" }, intake: { fields: ["name", "email", "message", "phone"] } }));
  expect(requests.some(request => /connections|deployments|booking-policies/.test(request.path))).toBe(false);
});
test("booking-only setup skips knowledge and closing preserves the current step", async ({ page }) => {
  const requests = await fixture(page); let dialog = await start(page);
  await dialog.getByLabel("Business name", { exact: true }).fill("Salon");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByLabel(/Answer questions/).uncheck(); await dialog.getByLabel(/Handle support/).uncheck(); await dialog.getByLabel(/Book appointments/).check();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Where will customers use it?" })).toBeVisible();
  expect(requests).toHaveLength(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: "Create agent", exact: true }).filter({ visible: true }).click();
  dialog = page.getByRole("dialog", { name: "Create agent", exact: true });
  await expect(dialog.getByRole("heading", { name: "Where will customers use it?" })).toBeVisible();
  await dialog.getByRole("button", { name: "Back", exact: true }).click();
  await expect(dialog.getByLabel(/Book appointments/)).toBeChecked();
});
