import { agentSummary } from "./workspace-fixtures";
import { toolCatalogue } from "./catalogue-fixtures";
import { resolve } from "node:path";
import { test, expect } from "@playwright/test";

for (const width of [1440, 768, 390]) {
  test(`mock transport: customer knowledge pins and human support remain explicit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const sources = [{ id: "returns", title: "Returns", state: "active", visibility: "public", revisions: [1, 2].map(revision => ({ id: `revision${revision}`, revision, state: "approved", embeddingRelease: "local-embedding-v1" })) },
      { id: "unindexed", title: "Unindexed", state: "active", visibility: "public", revisions: [{ id: "revision3", revision: 1, state: "approved", embeddingRelease: null }] }];
    const base = { executionKind: "business", program: { id: "grounded-conversation", version: "1" }, instructions: "Answer from approved knowledge. Offer human support when needed.", model: { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free", maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 }, sourceRevisionIds: ["revision1"], connectedToolBindingIds: [], retrievalProfile: { kind: "lexical-v1" }, tools: ["knowledge.search", "knowledge.read", "channel.request_handoff", "support.get_status"], supportHours: { timeZone: "Africa/Johannesburg", intervals: [{ day: 1, start: "09:00", end: "17:00" }] }, memory: { enabled: false }, capabilities: { delegation: { enabled: false }, sandbox: { enabled: false }, businessActions: { enabled: false }, workflows: { enabled: false }, schedules: { enabled: false } } };
    let draft = structuredClone(base), draftRevision = 1;
    const versions: { id: string; number: number; configuration: typeof base }[] = [], unexpected: string[] = [], errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/**", async route => {
      const request = route.request(), path = new URL(request.url()).pathname;
      let data: unknown;
      if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: "org", name: "Support", role: "owner" }] };
      else if (path.endsWith("/knowledge/sources")) data = { sources, imports: [] };
      else if (path.endsWith("/catalogue/tools")) data = toolCatalogue;
      else if (path.endsWith("/agents/root")) {
        if (request.method() === "PUT") { const body = request.postDataJSON(); expect(body.expectedRevision).toBe(draftRevision); draft = body.configuration; draftRevision++; }
        data = { agent: { id: "root", name: "Customer support", draft, draftRevision }, versions, deployments: [] };
      } else if (path.endsWith("/agents/root/configuration")) {
        const body = request.postDataJSON(); expect(body.expectedRevision).toBe(draftRevision); draft = body.configuration; draftRevision++;
        const snapshot = { id: `version-${versions.length + 1}`, number: versions.length + 1, configuration: structuredClone(draft) }; versions.unshift(snapshot); data = { agent: { id: "root", name: "Customer support", draft, draftRevision }, snapshot, deployments: [] };
      } else if (path.endsWith("/agents/summaries")) data = { agents: [agentSummary({ id: "root", name: "Customer support" }, versions[0])], nextCursor: null };
      else if (path.endsWith("/conversations")) data = { conversations: [], nextCursor: null };
      else { unexpected.push(path); await route.fulfill({ status: 404, json: { error: { message: "Unexpected customer editor dependency" } } }); return; }
      await route.fulfill({ json: data });
    });
    await page.goto("/app/agents/root?section=configuration");
    await expect(page.getByRole("textbox", { name: "Instructions", exact: true })).toHaveValue(base.instructions);
    const knowledge = page.getByRole("group", { name: "Knowledge", exact: true });
    await expect(page.getByRole("combobox", { name: "Returns revision", exact: true })).toHaveValue("revision1");
    await page.getByRole("combobox", { name: "Returns revision", exact: true }).selectOption("revision2");
    await page.getByText("Search options", { exact: true }).click();
    await page.getByRole("combobox", { name: "Search method", exact: true }).selectOption("hybrid-v1");
    await knowledge.getByRole("checkbox", { name: /Unindexed/ }).check();
    await expect(page.getByRole("alert")).toContainText("Selected sources do not support");
    await knowledge.getByRole("checkbox", { name: /Unindexed/ }).uncheck();
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    const handoff = page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Human support", exact: true }) });
    await expect(handoff.getByText("Added", { exact: true })).toBeVisible();
    await handoff.getByRole("button", { name: "Remove Human support", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(handoff.getByRole("button", { name: "Add Human support", exact: true })).toBeVisible();
    for (const label of ["Use personal memory", "Delegate to specialists", "Run Python analysis", "Prepare reports for approval"]) await expect(page.getByRole("checkbox", { name: label, exact: true })).toHaveCount(0);
    for (const label of ["Memory"]) await expect(page.getByRole("button", { name: label, exact: true })).toHaveCount(0);
    await expect(page.getByRole("group", { name: "Connected tools", exact: true })).toHaveCount(0);
    await expect(page.getByRole("article").filter({ has: page.getByRole("heading", { name: "Knowledge search", exact: true }) }).getByText("Added", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    expect(draft).toMatchObject({ program: base.program, sourceRevisionIds: ["revision2"], connectedToolBindingIds: [], tools: ["knowledge.search", "knowledge.read"], retrievalProfile: { kind: "hybrid-v1", embeddingRelease: "local-embedding-v1" }, memory: { enabled: false }, capabilities: base.capabilities });
    await expect(page.getByRole("combobox", { name: "Version", exact: true })).toHaveCount(0);
    await handoff.getByRole("button", { name: "Add Human support", exact: true }).click(); await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    expect(draft.tools).toContain("channel.request_handoff"); expect(draft.tools).toContain("support.get_status"); expect(versions[1].configuration.tools).not.toContain("channel.request_handoff");
    expect(draft.supportHours).toEqual(base.supportHours); expect(versions[1].configuration.supportHours).toEqual(base.supportHours);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.mouse.move(1, 1);
    await expect(page.getByText("Changes saved", { exact: true }).last()).not.toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: resolve(process.cwd(), `../../../.audit/customer-agent-config-${width}.png`), fullPage: true, animations: "disabled" });
    sources[0].revisions[1].state = "withdrawn";
    await page.getByRole("button", { name: "General", exact: true }).click();
    await page.reload();
    await expect(page.getByRole("combobox", { name: "Returns revision", exact: true })).toHaveValue("revision2");
    await expect(page.getByRole("checkbox", { name: /Returns.*Unavailable/ })).toBeChecked();
    await page.getByRole("checkbox", { name: /Returns.*Unavailable/ }).uncheck();
    await page.getByText("Search options", { exact: true }).click();
    await page.getByRole("combobox", { name: "Search method", exact: true }).selectOption("lexical-v1");
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    expect(draft.sourceRevisionIds).toEqual([]); expect(versions[1].configuration.sourceRevisionIds).toEqual(["revision2"]);
    expect(unexpected).toEqual([]); expect(errors).toEqual([]);
  });
}

test("mock transport: creation uses the real catalogue and sends the chosen customer offering", async ({ page }) => {
  let attempts = 0, created: { name: string; offering: string } | null = null;
  const configuration = { executionKind: "business", program: { id: "grounded-conversation", version: "1" }, instructions: "Help customers using approved knowledge.", model: { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free", maxOutputTokens: 1024, maxDurationSeconds: 120 }, tools: ["knowledge.search", "knowledge.read", "channel.request_handoff"], capabilities: { delegation: { enabled: false }, sandbox: { enabled: false }, businessActions: { enabled: false }, workflows: { enabled: false }, schedules: { enabled: false } } };
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: "org", name: "Support", role: "owner" }] };
    else if (path.endsWith("/offerings")) {
      if (++attempts === 1) { await route.fulfill({ status: 503, json: { error: { message: "Catalogue temporarily unavailable" } } }); return; }
      data = { offerings: [{ id: "faq", name: "FAQ", available: true }, { id: "customer-service", name: "Customer service", available: true }, { id: "booking", name: "Booking", available: false }] };
    } else if (path.endsWith("/agents/summaries")) data = { agents: [], nextCursor: null };
    else if (path.endsWith("/agents") && request.method() === "POST") { created = request.postDataJSON(); data = { agent: { id: "created", ...created, draft: configuration, draftRevision: 1 } }; }
    else if (path.endsWith("/agents/created")) data = { agent: { id: "created", ...created, draft: configuration, draftRevision: 1 }, versions: [], deployments: [] };
    else if (path.endsWith("/knowledge/sources")) data = { sources: [], imports: [] };
    else if (path.endsWith("/conversations")) data = { conversations: [], nextCursor: null };
    else { await route.fulfill({ status: 404, json: { error: { message: "Unexpected customer catalogue endpoint" } } }); return; }
    await route.fulfill({ json: data });
  });
  await page.goto("/app/agents");
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Name", exact: true }).fill("Acme customer support");
  await expect(dialog.getByRole("alert")).toContainText("Catalogue temporarily unavailable");
  await expect(dialog.getByRole("button", { name: "Create agent", exact: true })).toBeDisabled(); expect(created).toBeNull();
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(dialog.getByRole("combobox", { name: "Agent type", exact: true })).toHaveValue("faq");
  await expect(dialog.getByRole("option", { name: "Booking · Unavailable", exact: true })).toHaveJSProperty("disabled", true);
  await dialog.getByRole("combobox", { name: "Agent type", exact: true }).selectOption("customer-service");
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(process.cwd(), `../../../.audit/customer-agent-create-${width}.png`), fullPage: true, animations: "disabled" });
  }
  await dialog.getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Instructions", exact: true })).toHaveValue(configuration.instructions);
  expect(created).toEqual({ name: "Acme customer support", offering: "customer-service" }); expect(attempts).toBe(2);
});
