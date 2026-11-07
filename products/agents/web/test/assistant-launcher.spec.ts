import { expect, test, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111";
const account = { id: "member", email: "member@example.test", displayName: "Member" };
const assistant = { state: "configured", agent: { id: "assistant-1", name: "Business assistant" }, version: { id: "version-1", number: 1 } };
const configuration = { executionKind: "business", program: { id: "tool-directed", version: "1" }, productBindings: [], instructions: "Help this member.", context: { maxInputTokens: 8192, compactAtTokens: 6144 }, model: { selection: { kind: "organization_default" }, maxInputBytes: 16384, maxOutputTokens: 4096, maxDurationSeconds: 120 }, sourceRevisionIds: [], connectedToolBindingIds: [], tools: ["tasks.inspect", "tasks.cancel"], memory: { enabled: false }, capabilities: { delegation: { enabled: false }, sandbox: { enabled: false }, businessActions: { enabled: false }, workflows: { enabled: false }, schedules: { enabled: false } } };
const agent = { id: "assistant-1", name: "Business assistant", offering: null, draft: configuration, draftRevision: 1 };
const connection = { id: "conn-1", providerId: "office", name: "Office", endpoint: "https://models.example.test", revision: 1, credentialRevision: 1, state: "active", verification: "tools_verified" };
const capability = { value: true, evidence: "verified" as const };
const model = { id: "nova", name: "Nova", inputModalities: ["text"], outputModalities: ["text"], contextTokens: { value: 64000 }, maxOutputTokens: { value: 4096 }, capabilities: { tools: capability, reasoning: { value: null, evidence: "unknown" as const }, structuredOutput: { value: null, evidence: "unknown" as const } }, lifecycle: "active" as const, pricing: null };

type Conversation = { id: string; title: string };
type ChannelLink = { id: string; connectionId: string; kind: string; state: string; senderLabel: string; expiresAt: string | null; conversationId: string | null };
async function launcher(page: Page, options: { role?: string; state?: string; channelsEnabled?: boolean; deliveryState?: string } = {}) {
  const conversations: Conversation[] = [{ id: "conv-1", title: "Launch plan" }, { id: "conv-2", title: "Hiring draft" }];
  const archived: Conversation[] = [];
  const saved: unknown[] = [];
  const channel = { id: "bot-1", kind: "telegram", label: "Office bot" };
  const links: ChannelLink[] = [];
  if (options.deliveryState) links.push({ id: "link-1", connectionId: channel.id, kind: channel.kind, state: "active", senderLabel: "@office-member", expiresAt: null, conversationId: "conversation-1" });
  const calls: string[] = [];
  let paired = false;
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname;
    const method = request.method();
    let data: unknown;
    if (path === "/api/session") data = { account, organizations: [{ id: org, name: "Office", role: options.role ?? "member" }] };
    else if (path.endsWith("/inbox-alerts")) data = { unread: 0, alerts: [] };
    else if (path.endsWith("/assistant/repair")) { calls.push("repair"); data = { ...assistant, state: "draft" }; }
    else if (path.endsWith("/assistant")) data = options.state === "absent" || options.state === "deleted" ? { state: options.state, agent: null, version: null } : assistant;
    else if (path.endsWith("/member-channels/challenges")) { calls.push("challenge"); links.push({ id: "challenge-1", connectionId: channel.id, kind: channel.kind, state: "challenge", senderLabel: "", expiresAt: new Date(Date.now() + 300_000).toISOString(), conversationId: null }); data = { id: "challenge-1", token: "private-code", expiresAt: new Date(Date.now() + 300_000).toISOString() }; }
    else if (path.endsWith("/member-channels/link-1/confirm")) { calls.push("confirm"); links[0].state = "active"; links[0].conversationId = "conversation-1"; data = {}; }
    else if (path.endsWith("/member-channels/link-1") && method === "DELETE") { calls.push("revoke"); links[0].state = "revoked"; data = {}; }
    else if (path.endsWith("/member-channels")) {
      if (paired && !links.some(link => link.state === "pending" || link.state === "active")) { links.splice(0, links.length, { id: "link-1", connectionId: channel.id, kind: channel.kind, state: "pending", senderLabel: "@office-member", expiresAt: new Date(Date.now() + 300_000).toISOString(), conversationId: null }); paired = false; }
      data = { enabled: options.channelsEnabled ?? true, links, connections: [channel], deliveries: options.deliveryState ? [{ id: "delivery-1", linkId: "link-1", taskId: "task-1", state: options.deliveryState, reason: null, segment: 1, updatedAt: new Date().toISOString() }] : [] };
    }
    else if (path.endsWith("/conversations") && method === "GET") {
      const items = url.searchParams.get("state") === "archived" ? archived : conversations;
      data = { conversations: items.map(item => ({ ...item, agentId: agent.id, agentName: agent.name, versionId: "version-1", versionNumber: 1, updatedAt: new Date().toISOString(), state: "completed", canContinue: true })), nextCursor: null };
    } else if (/\/conversations\/[^/]+\/(archive|restore)$/.test(path) && method === "POST") {
      const id = path.split("/").at(-2)!, restore = path.endsWith("/restore");
      const from = restore ? archived : conversations, to = restore ? conversations : archived;
      const index = from.findIndex(item => item.id === id);
      if (index < 0) return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
      to.push(...from.splice(index, 1));
      data = { id, archived: !restore };
    } else if (/\/conversations\/[^/]+$/.test(path) && method === "GET") {
      data = { tasks: [], nextCursor: null, conversation: { agentId: agent.id, versionId: "version-1", versionNumber: 1 } };
    } else if (path.endsWith("/agents/assistant-1/configuration") && method === "POST") { saved.push(request.postDataJSON()); agent.draft = request.postDataJSON().configuration; agent.draftRevision++; data = { agent, snapshot: { id: "version-2", number: 2, configuration: agent.draft } }; }
    else if (path.endsWith("/agents/assistant-1")) data = { agent, versions: [{ id: "version-1", number: 1, configuration }], deployments: [] };
    else if (path.endsWith("/model-providers")) data = { connections: [connection] };
    else if (path.endsWith("/model-providers/default")) data = { selection: null, revision: 1 };
    else if (path.includes("/model-providers/conn-1/models")) data = { result: { kind: "discovered", models: [model], observedAt: new Date().toISOString(), visibility: "credential_scoped", complete: true }, toolSupport: { nova: "supported" }, stale: false, fetchedAt: new Date().toISOString(), connectionRevision: 1, credentialRevision: 1 };
    else if (path.endsWith("/agents/assistant-1/memory")) data = { items: [], candidates: [], nextOffset: null };
    else return route.fulfill({ status: 404, json: { error: { message: "Not found" } } });
    return route.fulfill({ json: data });
  });
  return { saved, calls, pair: () => { paired = true; } };
}

async function openPanel(page: Page) {
  await page.goto("/app/overview");
  await page.getByRole("button", { name: "Assistant", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Assistant" })).toBeVisible();
}

test("sidebar assistant opens a chat panel with history and settings tabs", async ({ page }) => {
  await launcher(page);
  await openPanel(page);
  const dialog = page.getByRole("dialog", { name: "Assistant" });
  await expect(dialog.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
  await expect(dialog.getByRole("textbox", { name: "Message", exact: true })).toBeVisible();
  await dialog.getByRole("tab", { name: "History" }).click();
  await expect(dialog.getByText("Launch plan", { exact: true })).toBeVisible();
  await dialog.getByRole("tab", { name: "Settings" }).click();
  await expect(dialog.getByRole("heading", { name: "Model" })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /Memory/ })).toBeVisible();
});

test("history searches, pins, archives and restores conversations", async ({ page }) => {
  await launcher(page);
  await openPanel(page);
  const dialog = page.getByRole("dialog", { name: "Assistant" });
  await dialog.getByRole("tab", { name: "History" }).click();
  await dialog.getByRole("textbox", { name: "Search conversations" }).fill("launch");
  await expect(dialog.getByText("Launch plan", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Hiring draft", { exact: true })).toHaveCount(0);
  await dialog.getByRole("textbox", { name: "Search conversations" }).fill("");
  await dialog.getByRole("button", { name: "Pin Hiring draft" }).click();
  await expect(dialog.getByRole("button", { name: "Unpin Hiring draft" })).toBeVisible();
  await dialog.getByRole("button", { name: "Archive Launch plan" }).click();
  await expect(dialog.getByText("Launch plan", { exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "Archived", exact: true }).click();
  await expect(dialog.getByText("Launch plan", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Restore Launch plan" }).click();
  await dialog.getByRole("button", { name: "Hide archived", exact: true }).click();
  await expect(dialog.getByText("Launch plan", { exact: true })).toBeVisible();
});

test("settings saves a model selection for the assistant", async ({ page }) => {
  const { saved } = await launcher(page);
  await openPanel(page);
  const dialog = page.getByRole("dialog", { name: "Assistant" });
  await dialog.getByRole("tab", { name: "Settings" }).click();
  await expect(dialog.getByRole("heading", { name: "Model" })).toBeVisible();
  await dialog.getByRole("button", { name: "Chat model: Choose model" }).click();
  const picker = page.getByRole("dialog", { name: "Choose model" });
  await picker.getByRole("radio", { name: "Nova" }).check();
  await picker.getByRole("button", { name: "Save model", exact: true }).click();
  await expect.poll(() => saved.length).toBe(1);
  expect(saved[0]).toMatchObject({ name: "Business assistant", configuration: { model: { selection: { kind: "connection", connectionId: "conn-1", modelId: "nova" } } }, expectedRevision: 1 });
});

test("owner restores a removed assistant from the panel setup", async ({ page }) => {
  const { calls } = await launcher(page, { role: "owner", state: "deleted" });
  await openPanel(page);
  const dialog = page.getByRole("dialog", { name: "Assistant" });
  await expect(dialog.getByText("Assistant removed", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Restore assistant" }).click();
  await expect(dialog.getByRole("link", { name: "Configure", exact: true })).toHaveAttribute("href", "/app/agents/assistant-1?section=configuration");
  expect(calls).toEqual(["repair"]);
});

test("member sees unavailable setup without an owner repair action", async ({ page }) => {
  await launcher(page, { state: "absent" });
  await openPanel(page);
  const dialog = page.getByRole("dialog", { name: "Assistant" });
  await expect(dialog.getByText("Ask an owner to set up the assistant.")).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Set up assistant" })).toHaveCount(0);
});

test("member pairs, confirms and unlinks a messaging account in channels", async ({ page }) => {
  const { calls, pair } = await launcher(page);
  await openPanel(page);
  const dialog = page.getByRole("dialog", { name: "Assistant" });
  await dialog.getByRole("tab", { name: "Channels" }).click();
  await expect(dialog.getByRole("heading", { name: "Your messaging accounts" })).toBeVisible();
  await dialog.getByRole("button", { name: "Link Office bot" }).click();
  await expect(dialog.getByText("/pair private-code", { exact: true })).toBeVisible();
  pair();
  await expect(dialog.getByText("@office-member", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Confirm account", exact: true }).click();
  await expect(page.getByRole("alertdialog")).toContainText("@office-member on Telegram will access your assistant in Office.");
  expect(calls).toEqual(["challenge"]);
  await page.getByRole("alertdialog").getByRole("button", { name: "Confirm account", exact: true }).click();
  await expect(dialog.getByRole("link", { name: "Open conversation" })).toHaveAttribute("href", "/app/agents/assistant-1/conversations/conversation-1");
  await dialog.getByRole("button", { name: "Unlink", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  expect(calls).toEqual(["challenge", "confirm"]);
  await dialog.getByRole("button", { name: "Unlink", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Unlink", exact: true }).click();
  await expect(dialog.getByText("@office-member", { exact: true })).toHaveCount(0);
  expect(calls).toEqual(["challenge", "confirm", "revoke"]);
});

test("disabled private messaging blocks new links", async ({ page }) => {
  await launcher(page, { channelsEnabled: false });
  await openPanel(page);
  const dialog = page.getByRole("dialog", { name: "Assistant" });
  await dialog.getByRole("tab", { name: "Channels" }).click();
  await expect(dialog.getByText("Private messaging unavailable", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Link Office bot" })).toBeDisabled();
});
