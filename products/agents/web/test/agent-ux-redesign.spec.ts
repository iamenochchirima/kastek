import { test, expect, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111";
const agentId = "22222222-2222-4222-8222-222222222222";
const versionId = "44444444-4444-4444-8444-444444444444";
const deploymentId = "55555555-5555-4555-8555-555555555555";
const sourceId = "66666666-6666-4666-8666-666666666666";
const revisionId = "77777777-7777-4777-8777-777777777777";

const supportHours = { timeZone: "Africa/Johannesburg", intervals: [{ day: 1, start: "09:00", end: "17:00" }] };
const setup = { business: { name: "Sandwich Baron", website: "https://sandwichbaron.co.za", description: "Sandwiches" }, responsibilities: ["answer-questions", "customer-support"], channels: ["website"], behaviour: { agentName: "Support", language: "English", tone: "friendly", handoffInstructions: "" }, supportHours, intake: { fields: ["name", "email", "message"] } };
const configuration = {
  executionKind: "business", instructions: "Answer customer questions.", sourceRevisionIds: [revisionId], connectedToolBindingIds: [], skillIds: [],
  model: { selection: { kind: "organization_default" }, maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 },
  supportHours, memory: { enabled: true }, retrievalProfile: { kind: "lexical-v1" },
  tools: ["knowledge.search", "knowledge.read", "channel.request_handoff", "support.request_handoff_v2", "support.get_status_v2", "enquiry.submit"],
  capabilities: { delegation: { enabled: false }, sandbox: { enabled: false }, businessActions: { enabled: true, profileId: "calendar-booking-v1", policyId: "policy-1", policyDigest: "digest-1" }, workflows: { enabled: false }, schedules: { enabled: false }, enquiries: { enabled: true, fields: ["name", "email", "message"] } },
};
const knowledge = [{ id: sourceId, organizationId: org, importerAccountId: "owner", title: "Menu and prices", kind: "public_url", generation: 1, state: "active", visibility: "public", createdAt: "2026-10-20T10:00:00Z", canApprove: true, revisions: [{ id: revisionId, revision: 1, state: "approved", acquiredAt: "2026-10-20T10:00:00Z" }] }];

async function fixture(page: Page) {
  let currentSetup = structuredClone(setup);
  const capabilityBodies: Record<string, unknown>[] = [];
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname, method = request.method();
    const body = request.postData() ? request.postDataJSON() : {};
    const agent = () => ({ id: agentId, name: "Support", avatar: "scout", offering: "customer-service", setup: currentSetup, setupStep: "complete", draft: configuration, draftRevision: 1, updatedAt: "2026-10-22T10:00:00Z" });
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: org, name: "Workspace", role: "owner" }] };
    else if (path.endsWith("/assistant")) data = { agent: null };
    else if (path.endsWith("/agents/summaries")) data = { agents: [{ id: agentId, name: "Support", avatar: "scout", offering: "customer-service", responsibilities: currentSetup.responsibilities, activeChannels: ["website"], lastCustomerConversationAt: "2026-10-22T10:00:00Z", draftRevision: 1, updatedAt: "2026-10-22T10:00:00Z", latestVersion: { id: versionId, number: 1, draftRevision: 1, executionKind: "business" }, hasUnpublishedChanges: false }], nextCursor: null };
    else if (path.endsWith(`/agents/${agentId}/overview`)) data = { period: { days: Number(url.searchParams.get("days") ?? 7) }, counts: { conversations: 12, messages: 34, needsAttention: 2, activeChannels: 2, knowledgeSources: 3, knowledgeChunks: 42 }, conversationActivity: Array.from({ length: 7 }, (_, index) => ({ date: `2026-11-0${index + 1}`, count: index % 3 })), needsAttention: [{ id: "conversation-2", agentName: "Support", channel: "website", state: "handoff_pending", updatedAt: "2026-10-22T09:00:00Z" }], recentActivity: [{ id: "conversation-1", agentName: "Support", channel: "website", state: "automation_active", updatedAt: "2026-10-22T10:00:00Z" }], channels: [{ channel: "website", count: 9 }, { channel: "whatsapp", count: 3 }] };
    else if (path.endsWith(`/agents/${agentId}/setup-readiness`)) data = { readiness: { readyToTest: true, setupStep: "complete", requirements: { model: { state: "ready", code: null }, knowledge: { state: "ready", code: null }, customerKnowledge: { state: "ready", code: null }, bookings: { state: "ready", code: null }, enquiries: { state: "ready", code: null }, handoff: { state: "ready", code: null } }, channels: [{ kind: "website", state: "connected" }] } };
    else if (path.endsWith(`/agents/${agentId}/capabilities`) && method === "PUT") {
      if (!body.confirmImpact) { await route.fulfill({ status: 409, json: { error: { code: "CONFIGURATION_CONFIRMATION_REQUIRED", message: "Confirm capability changes." } } }); return; }
      capabilityBodies.push(body);
      currentSetup = { ...currentSetup, responsibilities: body.responsibilities };
      data = { agent: agent(), snapshot: { id: "snapshot-2", number: 2, configuration, createdAt: "2026-10-22T10:00:00Z" } };
    } else if (path.endsWith(`/agents/${agentId}`)) data = { agent: agent(), versions: [{ id: versionId, number: 1, configuration, createdAt: "2026-10-20T10:00:00Z" }], deployments: [{ id: deploymentId, versionId, allowedOrigins: ["https://www.sandwichbaron.co.za"] }] };
    else if (path.endsWith(`/deployments/${deploymentId}/appearance`)) data = { deploymentId, appearance: { accent: "#3730a3", position: "bottom-right", launcherLabel: "Chat", title: "Support", subtitle: "", greeting: "Hi", avatarUrl: "", quickReplies: [], showBranding: true, theme: "light", borderRadius: 16, launcherSize: 56, launcherOffset: 24, windowWidth: 380, windowHeight: 560 }, appearanceDigest: "appearance-1", paused: false, allowedOrigins: ["https://www.sandwichbaron.co.za"] };
    else if (path.endsWith("/knowledge/sources")) data = { sources: knowledge, imports: [] };
    else if (path.endsWith("/conversations")) data = { conversations: [{ id: "conversation-1", agentId, agentName: "Support", versionId, versionNumber: 1, title: "Delivery options", updatedAt: "2026-10-22T10:00:00Z", state: "automation_active", canContinue: true }, { id: "conversation-2", agentId, agentName: "Support", versionId, versionNumber: 1, title: "Order change", updatedAt: "2026-10-22T09:00:00Z", state: "handoff_pending", canContinue: true }], nextCursor: null };
    else if (path.endsWith("/model-providers/default")) data = { selection: { kind: "connection", connectionId: "provider-a", modelId: "model-a" }, revision: 1 };
    else if (path.endsWith("/model-providers")) data = { connections: [{ id: "provider-a", providerId: "openai", name: "OpenAI account", state: "active" }] };
    else if (/\/model-providers\/[^/]+\/models$/.test(path)) data = { stale: false, result: { kind: "discovered", models: [{ id: "model-a", name: "GPT fixture", lifecycle: "active", inputModalities: ["text"], outputModalities: ["text"], contextTokens: { value: 128000 }, maxOutputTokens: { value: 32768 }, capabilities: { tools: { value: true, evidence: "discovered" } } }] } };
    else if (path.endsWith("/model-policy")) data = { modelId: "model-a", modelRevision: "model-1", limits: { contextTokens: 128000, maxInputTokens: 65536, maxOutputTokens: 16384, maxCallDurationMs: 180000, maxRootTokens: 32000, safetyTokens: 1024 }, effectivePolicy: {}, errors: [], controls: { temperature: { min: 0, max: 2, source: "fixture" }, reasoning: null } };
    else if (path.endsWith("/booking-policies")) data = { policies: [] };
    else if (path.endsWith("/provider-calendars/connections")) data = { connections: [] };
    else if (path.endsWith("/channels/growth/organizations")) data = { organizations: [{ id: "growth-org", name: "KasiTek Growth" }] };
    else if (path.endsWith("/channels")) data = { connections: [], deployments: [], websites: [{ id: deploymentId, agentId, agentName: "Support", allowedOrigins: ["https://www.sandwichbaron.co.za"] }] };
    else if (path.endsWith("/tool-bindings")) data = { bindings: [] };
    else if (path.endsWith("/skills")) data = { skills: [] };
    else if (path.endsWith("/connections")) data = { connections: [], targets: [] };
    else { await route.fulfill({ status: 404, json: { error: { message: `Unexpected ${method} ${path}` } } }); return; }
    await route.fulfill({ json: data });
  });
  return { capabilityBodies };
}

test("agent menu exposes the job-based sections with Overview by default", async ({ page }) => {
  await fixture(page);
  await page.goto(`/app/agents/${agentId}`);
  const menu = page.getByRole("navigation", { name: "Agent sections" });
  for (const name of ["Overview", "Conversations", "Capabilities", "Knowledge", "Behaviour", "Chat widget", "Deploy", "Settings"]) await expect(menu.getByRole("link", { name, exact: true })).toBeVisible();
  await expect(menu.getByRole("link", { name: "Overview", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
  await expect(page.getByText("Conversations", { exact: true }).first()).toBeVisible();
  await expect(page.locator(".overview-metric", { hasText: "Conversations" })).toContainText("12");
  await expect(page.locator(".overview-metric", { hasText: "Messages" })).toContainText("34");
  await expect(page.locator(".overview-metric", { hasText: "Knowledge sources" })).toContainText("3");
  await menu.getByRole("link", { name: "Conversations", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Conversations", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: /Delivery options/ })).toBeVisible();
  await menu.getByRole("link", { name: "Capabilities", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Capabilities", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Answer questions", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  await menu.getByRole("link", { name: "Knowledge", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Knowledge", exact: true })).toBeVisible();
  await expect(page.getByText("Menu and prices", { exact: true })).toBeVisible();
  await menu.getByRole("link", { name: "Behaviour", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Instructions", exact: true })).toHaveValue("Answer customer questions.");
  await menu.getByRole("link", { name: "Chat widget", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Chat widget", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Customize widget", exact: true })).toBeVisible();
  await menu.getByRole("link", { name: "Deploy", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Deploy", exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Customize widget", exact: true })).toBeVisible();
  await menu.getByRole("link", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Settings", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Delete agent", exact: true })).toBeVisible();
});

test("removing a capability updates the remaining responsibilities", async ({ page }) => {
  const { capabilityBodies } = await fixture(page);
  await page.goto(`/app/agents/${agentId}?section=capabilities`);
  const card = page.locator(".agent-capability-card", { hasText: "Handle support" });
  await card.getByRole("button", { name: "Remove", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("The agent stops using this capability");
  await dialog.getByRole("button", { name: "Remove capability", exact: true }).click();
  await expect(page.getByText("Capabilities updated", { exact: true })).toBeVisible();
  expect(capabilityBodies[0]).toMatchObject({ responsibilities: ["answer-questions"] });
});

test("agent menu and sections work at desktop, tablet and mobile widths", async ({ page }) => {
  await fixture(page);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/app/agents/${agentId}?section=overview`);
    await expect(page.getByRole("heading", { name: "Overview", exact: true })).toBeVisible();
    if (width <= 640) {
      await page.getByRole("button", { name: "Agent menu", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.getByRole("link", { name: "Capabilities", exact: true }).click();
    } else {
      await page.getByRole("navigation", { name: "Agent sections" }).getByRole("link", { name: "Capabilities", exact: true }).click();
    }
    await expect(page.getByRole("heading", { name: "Capabilities", exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: test.info().outputPath(`agent-ux-${width}.png`), fullPage: true });
  }
});
