import { expect, test, type Page } from "@playwright/test";

const org = "11111111-1111-4111-8111-111111111111";
const id = "33333333-3333-4333-8333-333333333333";
type State = "automation_active" | "handoff_pending" | "human_owned" | "resolved";

async function setup(page: Page, state: State, assigneeAccountId: string | null, role = "member", handoffBrief: { reason: string; brief: string } | null = null, handoffData: { requestedAt: string; firstHumanReplyAt: string | null } | null = null, uncertainEffects: Array<{operationId:string;kind:'contact_save_uncertain';reconciliation?:{state:'found'|'inconclusive'|'unavailable';observedAt:string}}> = []) {
  let conversation = { id, agentId: "agent", agentName: "Support agent", deploymentId: "deployment", versionId: "version", channel: "website", state, assigneeAccountId, revision: "1", ownershipGeneration: "1", createdAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z" };
  const commands: { action: string; expectedRevision: string; commandId: string }[] = [];
  let failure = 0;
  await page.route("**/api/**", async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/session") return route.fulfill({ json: { account: { id: "me", email: "staff@example.test", displayName: "Me" }, organizations: [{ id: org, name: "Workspace", role }] } });
    if (path.endsWith("/members")) return route.fulfill({ json: { members: [{ id: "me", displayName: "Me" }, { id: "other", displayName: "Alex" }] } });
    if (path.endsWith("/agents/summaries")) return route.fulfill({ json: { agents: [{ id: "agent", name: "Support agent" }], nextCursor: null } });
    if (path.endsWith("/channels")) return route.fulfill({ json: { connections: [] } });
    if (path.endsWith("/enquiries")) return route.fulfill({ json: { enquiries: [] } });
    if (path.endsWith("/inbox")) return route.fulfill({ json: { conversations: [conversation], nextCursor: null } });
    if (path.endsWith(`/inbox/${id}/connected-effects/operation/reconcile`)) {
      expect(route.request().postDataJSON().requestId).toMatch(/^[0-9a-f-]{36}$/);
      return route.fulfill({json:{state:'inconclusive'}});
    }
    if (path.endsWith(`/inbox/${id}/commands`)) {
      const command = route.request().postDataJSON(); commands.push(command);
      if (failure) { const status = failure; failure = 0; return route.fulfill({ status, json: { error: { message: "Action failed" } } }); }
      expect(command.expectedRevision).toBe(conversation.revision);
      if (command.action === "claim") conversation = { ...conversation, assigneeAccountId: "me" };
      if (command.action === "takeover" || command.action === "reopen") conversation = { ...conversation, state: "human_owned" };
      if (command.action === "return") conversation = { ...conversation, state: "automation_active" };
      if (command.action === "resolve") conversation = { ...conversation, state: "resolved" };
      conversation = { ...conversation, revision: String(Number(conversation.revision) + 1) };
      return route.fulfill({ json: {} });
    }
    if (path.endsWith(`/inbox/${id}`)) return route.fulfill({ json: { conversation, handoffBrief, handoff: handoffData, uncertainEffects, messages: [], nextSequence: "1", earlierBefore: null } });
    return route.fulfill({ status: 404, json: { error: { message: `Unexpected request ${path}` } } });
  });
  await page.goto(`/app/inbox?conversation=${id}`);
  const handoff = page.getByRole("region", { name: "Conversation ownership" });
  await expect(handoff).toBeVisible();
  return { handoff, commands, failNext: (status: number) => { failure = status; } };
}

test("shows uncertain contact saves to staff", async ({page}) => {
  await setup(page,"handoff_pending",null,"member",null,null,[{operationId:"operation",kind:"contact_save_uncertain"}]);
  await expect(page.getByText("Contact save could not be confirmed. Check HubSpot before trying again.")).toBeVisible();
  await expect(page.getByRole('button',{name:'Check HubSpot'})).toHaveCount(0);
});

test("lets an owner check an uncertain contact save",async({page})=>{
  await setup(page,"handoff_pending",null,"owner",null,null,[{operationId:"operation",kind:"contact_save_uncertain"}]);
  await page.getByRole('button',{name:'Check HubSpot'}).click();
  await expect(page.getByRole('status').getByText('Could not confirm the contact. Check HubSpot before trying again.')).toBeVisible();
});

test("restores the last contact check after reload",async({page})=>{
  await setup(page,"handoff_pending",null,"member",null,null,[{operationId:"operation",kind:"contact_save_uncertain",reconciliation:{state:'found',observedAt:'2026-10-29T10:00:00Z'}}]);
  await expect(page.getByRole('status').getByText('Contact found in HubSpot.')).toBeVisible();
  await page.reload();
  await expect(page.getByRole('status').getByText('Contact found in HubSpot.')).toBeVisible();
});

test("shows the agent handoff note on demand", async ({page}) => {
  await setup(page,"handoff_pending",null,"member",{reason:"Customer requested help",brief:"Customer asked about an order."});
  await page.getByText("Agent handoff note").click();
  await expect(page.getByText("Customer requested help")).toBeVisible();
  await expect(page.getByText("Customer asked about an order.")).toBeVisible();
});

test("shows the actual request age and first-reply state", async ({page}) => {
  const { handoff } = await setup(page,"handoff_pending",null,"member",null,{requestedAt:new Date(Date.now()-5*60_000).toISOString(),firstHumanReplyAt:null});
  await expect(handoff.getByText(/Awaiting first reply/)).toBeVisible();
  await expect(handoff.locator("time")).toHaveText("5 min");
});

test("shows a first reply only when the stored timestamp is present", async ({page}) => {
  const { handoff } = await setup(page,"human_owned","me","member",null,{requestedAt:"2026-10-01T12:00:00Z",firstHumanReplyAt:"2026-10-01T12:05:00Z"});
  await expect(handoff.getByText(/First reply/)).toBeVisible();
  await expect(handoff.getByText(/Awaiting first reply/)).toHaveCount(0);
});

test("handoff requires assignment before takeover and enables reply only after takeover", async ({ page }) => {
  const { handoff, commands } = await setup(page, "handoff_pending", null);
  await expect(handoff.getByText("Waiting for a person")).toBeVisible();
  await expect(handoff.getByRole("button", { name: "Take over" })).toHaveCount(0);
  await expect(page.getByLabel("Reply to customer")).toHaveCount(0);
  await handoff.getByRole("button", { name: "Assign to me" }).click();
  await expect(handoff.getByText("Assigned to you")).toBeVisible();
  await handoff.getByRole("button", { name: "Take over" }).click();
  await expect(handoff.getByText("Human support")).toBeVisible();
  await expect(page.getByLabel("Reply to customer")).toBeVisible();
  await handoff.getByRole("button", { name: "Return to Agent" }).click();
  await expect(handoff.getByText("Automation active")).toBeVisible();
  await expect(page.getByLabel("Reply to customer")).toHaveCount(0);
  expect(commands.map(command => command.action)).toEqual(["claim", "takeover", "return"]);
});

test("another teammate owns conversation and ordinary members cannot take over or reassign", async ({ page }) => {
  const { handoff } = await setup(page, "human_owned", "other");
  await expect(handoff.getByText("Assigned to Alex")).toBeVisible();
  await expect(handoff.getByRole("button", { name: "Take over" })).toHaveCount(0);
  await expect(handoff.getByRole("button", { name: "Unassign" })).toHaveCount(0);
  await expect(handoff.getByLabel("Assign conversation")).toHaveCount(0);
  await expect(page.getByLabel("Reply to customer")).toHaveCount(0);
});

test("resolved conversation can be reopened by its assignee", async ({ page }) => {
  const { handoff, commands } = await setup(page, "resolved", "me");
  await expect(handoff.getByText("Conversation resolved")).toBeVisible();
  await expect(page.getByLabel("Reply to customer")).toHaveCount(0);
  await handoff.getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByLabel("Reply to customer")).toBeVisible();
  expect(commands.map(command => command.action)).toEqual(["reopen"]);
});

test("ambiguous failure keeps the command for idempotent retry", async ({ page }) => {
  const { handoff, commands, failNext } = await setup(page, "handoff_pending", "me");
  failNext(503);
  await handoff.getByRole("button", { name: "Take over" }).click();
  await expect(page.getByRole("button", { name: "Retry pending action" })).toBeVisible();
  await expect(handoff.getByRole("button", { name: "Take over" })).toBeDisabled();
  await page.getByRole("button", { name: "Retry pending action" }).click();
  await expect(handoff.getByText("Human support")).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[0].commandId).toBe(commands[1].commandId);
});

test("a rejected stale action clears pending state and permits a new attempt", async ({ page }) => {
  const { handoff, commands, failNext } = await setup(page, "handoff_pending", "me");
  failNext(409);
  await handoff.getByRole("button", { name: "Take over" }).click();
  await expect(handoff.getByRole("button", { name: "Take over" })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Retry pending action" })).toHaveCount(0);
  await handoff.getByRole("button", { name: "Take over" }).click();
  await expect(handoff.getByText("Human support")).toBeVisible();
  expect(commands).toHaveLength(2);
  expect(commands[0].commandId).not.toBe(commands[1].commandId);
});
