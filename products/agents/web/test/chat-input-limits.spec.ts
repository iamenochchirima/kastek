import { expect, test } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111", agentId = "22222222-2222-4222-8222-222222222222", snapshotId = "33333333-3333-4333-8333-333333333333";
// API admission is covered separately with PostgreSQL and HTTP. This checks the actual composer and rejected-input recovery.
test("mock transport: composer submits a long draft intact and preserves it after byte-limit rejection", async ({ page }) => {
  const posts: { input: string }[] = [];
  const draft = { executionKind: "business", instructions: "Answer questions.", model: { selection: { kind: "organization_default" },
    maxInputBytes: 65536, maxOutputTokens: 4096, maxDurationSeconds: 120, maxCostMicros: null }, context: { maxInputTokens: 24000, compactAtTokens: 18000 },
    sourceRevisionIds: [], connectedToolBindingIds: [], skillIds: [], tools: [], memory: { enabled: false },
    capabilities: Object.fromEntries(["delegation", "sandbox", "businessActions", "workflows", "schedules"].map(key => [key, { enabled: false }])) };
  const agent = { id: agentId, name: "Support", draft, draftRevision: 1 }, snapshot = { id: snapshotId, number: 1, configuration: draft };
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test" }, organizations: [{ id: org, name: "Workspace", role: "owner" }] };
    else if (path.endsWith("/agents/summaries")) data = { agents: [{ ...agent, latestVersion: snapshot, hasUnpublishedChanges: false }], nextCursor: null };
    else if (path.endsWith(`/agents/${agentId}`)) data = { agent, versions: [snapshot], deployments: [] };
    else if (path.endsWith("/conversations")) data = { conversations: [], nextCursor: null };
    else if (path.endsWith("/tasks") && route.request().method() === "POST") {
      posts.push(route.request().postDataJSON());
      await route.fulfill({ status: 413, json: { error: { code: "INPUT_LIMIT", message: "The message exceeds the input limit" } } }); return;
    } else if (path.endsWith("/knowledge/sources")) data = { sources: [], imports: [] };
    else { await route.fulfill({ status: 404, json: { error: { message: "Not found" } } }); return; }
    await route.fulfill({ json: data });
  });
  await page.goto(`/app/agents/${agentId}?section=chat`);
  const composer = page.getByRole("textbox", { name: "Message", exact: true }), input = "a".repeat(20000);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(composer).toBeVisible(); await expect(composer).not.toHaveAttribute("maxlength", /.+/);
    await composer.fill(input); await expect(composer).toHaveValue(input);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.getByText("The message exceeds the input limit", { exact: true })).toBeVisible();
    await expect(composer).toHaveValue(input); expect(posts.at(-1)!.input).toBe(input);
  }
  expect(posts).toHaveLength(2);
});
