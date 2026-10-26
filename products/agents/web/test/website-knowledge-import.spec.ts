import { expect, test, type Page } from "@playwright/test";
const base = "/api/organizations/org", agentPath = `${base}/agents/agent`, crawlPath = `${agentPath}/website-crawls`;
const configuration = { executionKind: "business", instructions: "Answer from approved knowledge", model: { selection: { kind: "organization_default" }, maxInputBytes: 32000, maxOutputTokens: 4096, maxDurationSeconds: 120 }, tools: [], sourceRevisionIds: [], capabilities: { delegation: { enabled: false }, sandbox: { enabled: false }, businessActions: { enabled: false }, workflows: { enabled: false }, schedules: { enabled: false } } };
async function fixture(page: Page, options: { resume?: boolean; failImport?: boolean; unavailable?: boolean; imported?: boolean; attached?: boolean; approved?: boolean; withdrawn?: boolean; missing?: boolean; failed?: boolean } = {}) {
  const calls: { path: string; body: Record<string, unknown> | null }[] = [];
  const agent = { id: "agent", offering: "customer-service", name: "Shop assistant", draft: { ...configuration, sourceRevisionIds: options.attached ? ["revision"] : [], tools: options.attached ? ["knowledge.search", "knowledge.read"] : [] }, draftRevision: 1 };
  const pages = [{ id: "home", url: "https://example.com", title: "Home", markdown: "# Our shop\n<script>alert('not executable')</script>" }, { id: "about", url: "https://example.com/about", title: "About", markdown: "We repair bicycles." }];
  let crawl: Record<string, unknown> | null = options.resume ? { id: "crawl", url: "https://example.com", state: "completed", pages, completed: 2, total: 2, errorCode: null, ...(options.imported ? { importJobId: "job" } : {}) } : null;
  let generation = 1, approved = options.approved ?? false, visibility = "private", fail = options.failImport;
  const job = { id: "job", sourceId: "source", revisionId: "revision", revision: 1, state: options.failed ? "failed" : "ready", errorCode: null };
  const source = () => ({ id: "source", title: "Example website", generation, state: options.withdrawn ? "withdrawn" : "active", visibility, canApprove: true, revisions: [{ id: "revision", revision: 1, state: approved ? "approved" : "candidate" }] });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, method = request.method();
    const body = request.postData() ? request.postDataJSON() : null; calls.push({ path, body });
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test" }, organizations: [{ id: "org", name: "Workspace", role: "owner" }] };
    else if (path.endsWith("/agents/summaries")) data = { agents: options.resume ? [agent] : [], nextCursor: null };
    else if (path.endsWith("/offerings")) data = { offerings: [{ id: "faq", name: "FAQ", available: true }, { id: "customer-service", name: "Customer service", available: true }] };
    else if (path === `${base}/agents`) data = { agent };
    else if (path === agentPath) data = { agent, deployments: [], versions: [] };
    else if (path === crawlPath) {
      if (method === "POST") { expect(body.url).toBe("example.com"); crawl = { id: "crawl", url: "https://example.com", state: "scraping", pages: [], completed: 0, total: 2, errorCode: null }; }
      data = { crawls: crawl ? [crawl] : [], available: !options.unavailable, ...(method === "POST" ? { crawl } : {}) };
    } else if (path === `${crawlPath}/crawl`) { crawl = { ...crawl, state: "completed", pages, total: 2, completed: 2 }; data = { crawl }; }
    else if (path.endsWith("/crawl/import")) {
      if (fail) { fail = false; await route.abort("failed"); return; }
      crawl = { ...crawl, importJobId: "job" }; data = { crawl, job };
    } else if (path.endsWith("/crawl/cancel")) { crawl = { ...crawl, state: "cancelled" }; data = { crawl }; }
    else if (path === `${base}/knowledge/imports/job`) { if (options.missing) { await route.fulfill({ status: 404, json: { error: { message: "Import not found" } } }); return; } data = { job }; }
    else if (path === `${base}/knowledge/sources`) data = { sources: crawl?.importJobId ? [source()] : [], imports: crawl?.importJobId ? [job] : [] };
    else if (path.endsWith("/revisions/revision/preview")) data = { text: "We repair bicycles.", chunks: [], acquiredAt: "2026-10-26T12:00:00Z" };
    else if (path.endsWith("/sources/source/policy")) { expect(body.expectedGeneration).toBe(generation); generation++; if (body.action === "approve") approved = true; if (body.action === "visibility") visibility = body.visibility; data = { source: source() }; }
    else if (path === `${agentPath}/configuration`) { expect(approved).toBe(true); expect(body.confirmImpact).toBe(true); expect(body.configuration.sourceRevisionIds).toEqual(["revision"]); expect(body.configuration.tools).toEqual(["knowledge.search", "knowledge.read"]); agent.draft = body.configuration; agent.draftRevision = 2; data = { agent, snapshot: { id: "version", number: 1, configuration: body.configuration }, deployments: [] }; }
    else if (path.endsWith("/conversations")) data = { conversations: [], nextCursor: null };
    else if (path.endsWith("/model-providers/default")) data = { selection: null, revision: 0 };
    else if (path.endsWith("/model-providers")) data = { connections: [] };
    else { await route.fulfill({ status: 404, json: { error: { message: `Unexpected ${path}` } } }); return; }
    await route.fulfill({ json: data });
  });
  return calls;
}
async function create(page: Page) {
  await page.goto("/app/agents");
  if ((page.viewportSize()?.width ?? 1440) <= 640) await page.getByRole("button", { name: "Agents & history", exact: true }).click();
  await page.getByRole("button", { name: "Create agent", exact: true }).filter({ visible: true }).click();
  const dialog = page.getByRole("dialog", { name: "Create agent", exact: true });
  await dialog.getByLabel("Business name", { exact: true }).fill("Shop");
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await dialog.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Business knowledge", exact: true })).toBeVisible();
  return dialog;
}
for (const width of [1440, 768, 390]) test(`create, crawl, review and explicitly approve website knowledge at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 950 }); const calls = await fixture(page, { failImport: true });
  const dialog = await create(page);
  await dialog.getByLabel("Business website").fill("example.com");
  await dialog.getByRole("button", { name: "Crawl website", exact: true }).click();
  await expect(dialog.getByRole("status")).toContainText("Crawling website");
  await expect(dialog.getByRole("heading", { name: "Review pages" })).toBeVisible();
  await dialog.getByRole("button", { name: /Home https/ }).click();
  await expect(dialog.getByRole("region", { name: "Page preview" })).toContainText("<script>alert('not executable')</script>");
  await dialog.getByRole("checkbox", { name: "Include About", exact: true }).check();
  expect(calls.some(call => call.path.endsWith("/policy"))).toBe(false);
  await page.screenshot({ path: test.info().outputPath(`website-review-${width}.png`), fullPage: true });
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await dialog.getByRole("button", { name: "Import selected (1)" }).click();
  await expect(dialog.getByRole("alert")).toBeVisible();
  await dialog.getByRole("button", { name: "Import selected (1)" }).click();
  await expect(dialog.getByRole("heading", { name: "Review knowledge" })).toBeVisible();
  const imports = calls.filter(call => call.path.endsWith("/crawl/import"));
  expect(imports).toHaveLength(2); expect(imports[1].body).toEqual(imports[0].body); expect(imports[1].body?.pageIds).toEqual(["about"]);
  expect(calls.some(call => call.path.endsWith("/policy"))).toBe(false);
  await dialog.getByRole("checkbox", { name: "Allow use in public customer replies" }).check();
  await dialog.getByRole("button", { name: "Approve and use" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Website knowledge added");
  expect(calls.filter(call => call.path.endsWith("/policy")).map(call => call.body?.action)).toEqual(["approve", "visibility"]);
  expect(calls.filter(call => call.path === `${base}/agents`)).toHaveLength(1);
});
test("existing agent resumes completed crawl and can keep source private", async ({ page }) => {
  const calls = await fixture(page, { resume: true });
  await page.goto("/app/agents/agent?section=configuration");
  await page.getByRole("button", { name: "Import website", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Import website", exact: true });
  await expect(dialog.getByRole("heading", { name: "Review pages" })).toBeVisible();
  await dialog.getByRole("button", { name: "Import selected (2)" }).click();
  await dialog.getByRole("button", { name: "Approve and use" }).click();
  await expect(dialog.getByRole("status")).toHaveText("Website knowledge added");
  expect(calls.filter(call => call.path.endsWith("/policy")).map(call => call.body?.action)).toEqual(["approve"]);
});
test("website import remains optional when crawler is unavailable", async ({ page }) => {
  const calls = await fixture(page, { unavailable: true }); const dialog = await create(page);
  await expect(dialog.getByRole("status")).toContainText("unavailable");
  await dialog.getByLabel("Business website").fill("example.com");
  await expect(dialog.getByRole("button", { name: "Crawl website", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Skip for now" }).click();
  await expect(dialog.getByRole("heading", { name: "Where will customers use it?" })).toBeVisible();
  expect(calls.some(call => call.path === crawlPath && call.body)).toBe(false);
});
test("cancel stops a crawl without importing or approving knowledge", async ({ page }) => {
  const calls = await fixture(page); const dialog = await create(page);
  await dialog.getByLabel("Business website").fill("example.com");
  await dialog.getByRole("button", { name: "Crawl website", exact: true }).click();
  await dialog.getByRole("button", { name: "Cancel crawl", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Website crawl cancelled.");
  expect(calls.filter(call => call.path.endsWith("/crawl/cancel"))).toHaveLength(1);
  expect(calls.some(call => call.path.endsWith("/import") || call.path.endsWith("/policy"))).toBe(false);
  await dialog.getByRole("button", { name: "Try another crawl" }).click();
  await expect(dialog.getByLabel("Business website")).toHaveValue("example.com");
});

async function openExistingImport(page: Page) {
  await page.goto("/app/agents/agent?section=configuration");
  await page.getByRole("button", { name: "Import website", exact: true }).click();
  return page.getByRole("dialog", { name: "Import website", exact: true });
}
test("reload derives approved private attachment and requires explicit customer authorization", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 950 });
  const calls = await fixture(page, { resume: true, imported: true, approved: true, attached: true });
  const dialog = await openExistingImport(page);
  await expect(dialog.getByRole("status")).toHaveText("Website knowledge added");
  await expect(dialog.getByText("Private · unavailable to customer channels")).toBeVisible();
  expect(calls.some(call => call.path.endsWith("/policy") && call.body)).toBe(false);
  expect(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: test.info().outputPath("website-private-resume-390.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Allow customer replies", exact: true }).click();
  await expect(dialog.getByText("Available to customer channels")).toBeVisible();
  expect(calls.filter(call => call.path.endsWith("/policy")).map(call => call.body?.action)).toEqual(["visibility"]);
  await page.reload();
  await page.getByRole("button", { name: "Import website", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Website knowledge added");
});
test("resume approved unattached source without approving it again", async ({ page }) => {
  const calls = await fixture(page, { resume: true, imported: true, approved: true });
  const dialog = await openExistingImport(page);
  await dialog.getByRole("button", { name: "Use knowledge", exact: true }).click();
  await expect(dialog.getByRole("status")).toHaveText("Website knowledge added");
  expect(calls.some(call => call.path.endsWith("/policy") && call.body)).toBe(false);
});
for (const state of ["withdrawn", "missing", "failed"] as const) test(`resume ${state} knowledge without claiming it is usable`, async ({ page }) => {
  await fixture(page, { resume: true, imported: true, approved: true, attached: true, [state]: true });
  const dialog = await openExistingImport(page);
  await expect(dialog.getByText(state === "withdrawn" ? "Website knowledge withdrawn" : state === "missing" ? "Knowledge unavailable" : "Knowledge import failed.", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Website knowledge added", { exact: true })).toHaveCount(0);
});
