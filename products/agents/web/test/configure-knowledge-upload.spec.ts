import { expect, test, type Page } from "@playwright/test";
import { agentSummary } from "./workspace-fixtures";

const base = "/api/organizations/org";

async function fixture(page: Page) {
  let draftRevision = 1, uploads = 0;
  const sources = new Map<string, { approved: boolean; public: boolean }>();
  const source = (id: string) => {
    const state = sources.get(id) ?? { approved: false, public: false }, number = id.replace(/^source-/u, "");
    return { id, organizationId: "org", importerAccountId: "owner", title: `Document ${number}`, kind: "upload", generation: state.public ? 2 : 1, state: "active", visibility: state.public ? "public" : "private", createdAt: "2026-11-07T00:00:00.000Z", canApprove: true, revisions: [{ id: `revision-${number}`, revision: 1, state: state.approved ? "approved" : "candidate", acquiredAt: "2026-11-07T00:00:00.000Z", embeddingRelease: null }] };
  };
  const job = (id: string) => ({ id: `job-${id}`, sourceId: `source-${id}`, revisionId: `revision-${id}`, revision: 1, acceptedGeneration: 1, state: "ready", parserRelease: "fixture", deadline: "2026-11-07T00:10:00.000Z", contentType: "text/markdown", errorCode: null, createdAt: "2026-11-07T00:00:00.000Z" });
  let draft = { executionKind: "business", program: { id: "grounded-conversation", version: "1" }, context: { maxInputTokens: 8192, compactAtTokens: 6144 }, instructions: "Answer from approved knowledge.", model: { provider: "openrouter", model: "fixture", maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 }, sourceRevisionIds: [] as string[], connectedToolBindingIds: [], retrievalProfile: { kind: "lexical-v1" }, tools: ["knowledge.search", "knowledge.read"] as string[], memory: { enabled: false }, capabilities: { delegation: { enabled: false }, sandbox: { enabled: false }, businessActions: { enabled: false }, workflows: { enabled: false }, schedules: { enabled: false } } };
  const agent = () => ({ id: "root", name: "Sandwich Baron", offering: "customer-service", setup: { business: { name: "Sandwich Baron", website: "", description: "" }, responsibilities: ["answer-questions", "customer-support"], channels: [], behaviour: { agentName: "Sandwich Baron", language: "English", tone: "friendly", handoffInstructions: "" } }, draft, draftRevision });
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname, body = request.postData() ? request.postDataJSON() : null;
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: "org", name: "Sandwich Baron", role: "owner" }] };
    else if (path.endsWith("/inbox-alerts")) data = { unread: 0, alerts: [] };
    else if (path.endsWith("/model-providers")) data = { connections: [] };
    else if (path.endsWith("/model-providers/default")) data = { selection: null, revision: 1 };
    else if (path.endsWith("/model-policy")) data = { modelId: null, modelRevision: null, limits: { contextTokens: null, maxInputTokens: null, maxOutputTokens: null, maxCallDurationMs: null, maxRootTokens: null, safetyTokens: null }, effectivePolicy: null, errors: [], controls: { temperature: null, reasoning: null } };
    else if (path.endsWith("/setup-readiness")) data = { readiness: { readyToTest: false, setupStep: null, requirements: {}, channels: [] } };
    else if (path === `${base}/knowledge/sources`) data = { sources: [...sources.keys()].map(source), imports: [] };
    else if (path === `${base}/knowledge/imports`) { uploads++; const id = String(uploads); sources.set(`source-${id}`, { approved: false, public: false }); data = { job: job(id) }; }
    else if (path.startsWith(`${base}/knowledge/imports/`)) { const id = path.split("/").at(-1)!.replace(/^job-/u, ""); data = { job: job(id) }; }
    else if (path.endsWith("/policy")) { const id = path.split("/").at(-2)!, state = sources.get(id)!; if (body.action === "approve") state.approved = true; if (body.action === "visibility") state.public = true; data = { source: source(id) }; }
    else if (path === `${base}/agents/root`) data = { agent: agent(), versions: [], deployments: [] };
    else if (path === `${base}/agents/root/configuration`) { expect(body.expectedRevision).toBe(draftRevision); draft = body.configuration; draftRevision++; data = { agent: agent(), snapshot: { id: `version-${draftRevision}`, number: draftRevision, configuration: draft }, deployments: [] }; }
    else if (path === `${base}/agents/summaries`) data = { agents: [agentSummary({ id: "root", name: "Sandwich Baron" })], nextCursor: null };
    else if (path.endsWith("/conversations")) data = { conversations: [], nextCursor: null };
    else data = {};
    await route.fulfill({ json: data });
  });
  return { draft: () => draft };
}

test("configure adds documents later and keeps them through a config save", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const state = await fixture(page);
  await page.goto("/app/agents/root?section=configuration");
  await page.getByRole("button", { name: "Add documents", exact: true }).click();
  const first = page.getByRole("dialog", { name: "Add documents" });
  await first.getByLabel("Documents").setInputFiles({ name: "menu.json", mimeType: "application/json", buffer: Buffer.from('{"name":"Chicken Mayo","price":"R47"}') });
  await first.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(first.getByText("Ready to review")).toBeVisible();
  await first.getByRole("button", { name: "Use knowledge", exact: true }).click();
  await expect(first).toHaveCount(0);
  await expect(page.getByText("Document 1", { exact: true })).toBeVisible();
  expect(state.draft().sourceRevisionIds).toEqual(["revision-1"]);

  await page.getByRole("textbox", { name: "Instructions", exact: true }).fill("Answer from approved Sandwich Baron knowledge.");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect(state.draft()).toMatchObject({ instructions: "Answer from approved Sandwich Baron knowledge.", sourceRevisionIds: ["revision-1"] });

  await page.getByRole("button", { name: "Add documents", exact: true }).click();
  const second = page.getByRole("dialog", { name: "Add documents" });
  await second.getByLabel("Documents").setInputFiles({ name: "hours.csv", mimeType: "text/csv", buffer: Buffer.from("Name,Hours\nSandton,08:00-13:30\n") });
  await second.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(second.getByText("Ready to review")).toBeVisible();
  await second.getByRole("button", { name: "Use knowledge", exact: true }).click();
  await expect(second).toHaveCount(0);
  await expect(page.getByText("Document 2", { exact: true })).toBeVisible();
  expect(state.draft().sourceRevisionIds).toEqual(["revision-1", "revision-2"]);
  expect(state.draft().instructions).toBe("Answer from approved Sandwich Baron knowledge.");
});
