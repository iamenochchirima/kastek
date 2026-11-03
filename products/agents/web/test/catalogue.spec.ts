import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { agentSummary } from "./workspace-fixtures";
import { catalogueItem, toolCatalogue } from "./catalogue-fixtures";
import type { Catalogue, Configuration, SkillPackage } from "../src/platform/api";

const configuration: Configuration = { executionKind: "business", instructions: "Answer from approved knowledge.", model: { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free", maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 }, tools: ["knowledge.search", "knowledge.read"], skillIds: [], connectedToolBindingIds: [], capabilities: { delegation: { enabled: false }, sandbox: { enabled: false }, businessActions: { enabled: false }, workflows: { enabled: false }, schedules: { enabled: false } } };
async function fixture(page: Page, failInitially = false, initialConfiguration = configuration) {
  let draft = structuredClone(initialConfiguration), revision = 1, calls = 0;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const github = { ...catalogueItem("github", "GitHub"), kind: "native_api" as const, recommended: false, requires: { connectionProfiles: ["github-public-read-v1"], permissions: [] }, readiness: { state: "unavailable" as const, reasons: [{ code: "CUSTOMER_TOOL_UNSUPPORTED", message: "Connected tools are unavailable for this customer agent." }] }, action: { kind: "none" as const } };
  const skill: SkillPackage = { id: "skill1", name: "support-writing", description: "Write concise customer replies.", revision: 1, contentDigest: "sha256:skill-digest", compatibility: null, reviewState: "pending", createdAt: "2026-10-20T00:00:00Z", files: [{ path: "SKILL.md", size: 80, contentDigest: "file-digest" }] };
  let imported = false, reviewed = false, curatedInstalled = false;
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: "org", name: "Support", role: "owner" }] };
    else if (path.endsWith("/connectors")) data = { connectors: [] };
    else if (path.endsWith("/knowledge/sources")) data = { sources: [], imports: [] };
    else if (path.endsWith("/agents/root")) {
      if (request.method() === "PUT") { expect(request.postDataJSON().expectedRevision).toBe(revision); draft = request.postDataJSON().configuration; revision++; }
      data = { agent: { id: "root", name: "Customer support", offering: "faq", draft, draftRevision: revision }, versions: [], deployments: [] };
    } else if (path.endsWith("/agents/root/configuration")) { expect(request.postDataJSON().expectedRevision).toBe(revision); draft = request.postDataJSON().configuration; revision++; data = { agent: { id: "root", name: "Customer support", offering: "faq", draft, draftRevision: revision }, snapshot: { id: `snapshot-${revision}`, number: revision, configuration: structuredClone(draft) }, deployments: [] }; }
    else if (path.endsWith("/agents/summaries")) data = { agents: [agentSummary({ id: "root", name: "Customer support", draftRevision: revision })], nextCursor: null };
    else if (path.endsWith("/conversations")) data = { conversations: [], nextCursor: null };
    else if (path.endsWith("/catalogue/tools")) {
      expect(new URL(request.url()).searchParams.get("agentId")).toBe("root");
      if (++calls <= 2 && failInitially) { await route.fulfill({ status: 503, json: { error: { message: "Catalogue temporarily unavailable" } } }); return; }
      data = { ...toolCatalogue, entries: [...toolCatalogue.entries.map(item => {
        const added = item.configuration.tools.length > 0 && item.configuration.tools.every(id => draft.tools?.includes(id));
        return { ...item, added, action: added ? { kind: "none" } : item.action };
      }), github] };
    } else if (path.endsWith("/catalogue/skills")) {
      const entry = { ...catalogueItem("skill:skill1", skill.name), kind: "skill" as const, description: skill.description, publisher: { id: "org", name: "Support", verified: false }, configuration: { tools: [], connectedToolBindingIds: [], skillIds: ["skill1"] }, readiness: { state: reviewed ? "ready" : "unavailable", reasons: reviewed ? [] : [{ code: "REVIEW_REQUIRED", message: "Review required before adding this skill." }] }, action: { kind: reviewed ? "add" : "none" } };
      const curated = { ...catalogueItem("curated:grounded-answers", "grounded-answers"), kind: "skill" as const, source: { kind: "curated" as const, slug: "grounded-answers" }, configuration: { tools: [], connectedToolBindingIds: [], skillIds: curatedInstalled ? ["curated1"] : [] } };
      data = { ...toolCatalogue, entries: [curated, ...(imported ? [entry] : [])] } as Catalogue;
    } else if (path.endsWith("/skills/curated/grounded-answers/install")) {
      expect(request.postDataJSON().operationId).toBeTruthy(); curatedInstalled = true;
      data = { package: { ...skill, id: "curated1", name: "Grounded answers", reviewState: "reviewed" } };
    } else if (path.endsWith("/skills/curated/grounded-answers")) data = { skill: { name: "grounded-answers", description: "Answer from approved sources.", compatibility: null }, body: "Cite approved knowledge." };
    else if (path.endsWith("/skills/packages") && request.method() === "POST") {
      expect(request.postDataJSON().files).toEqual([{ path: "SKILL.md", content: "---\nname: support-writing\ndescription: Write concise customer replies.\n---\nWrite plainly." }]); imported = true; data = { package: skill };
    } else if (path.endsWith("/skills/packages/skill1/review")) {
      expect(request.postDataJSON()).toEqual({ contentDigest: skill.contentDigest }); reviewed = true; data = { package: { ...skill, reviewState: "reviewed" } };
    } else if (path.endsWith("/skills/packages/skill1")) data = { package: { ...skill, reviewState: reviewed ? "reviewed" : "pending" }, body: "Write plainly." };
    else { await route.fulfill({ status: 404, json: { error: { message: `Unexpected mock route ${path}` } } }); return; }
    await route.fulfill({ json: data });
  });
  return { draft: () => draft, errors };
}

for (const width of [1440, 768, 390]) {
  test(`mock transport: catalogue selection, readiness and draft save at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    const state = await fixture(page);
    await page.goto("/app/agents/root?section=tools");
    const catalogue = page.getByRole("region", { name: "Tools catalogue" });
    await expect(catalogue.getByRole("heading", { name: "Knowledge search", exact: true })).toBeVisible();
    if (width === 390) expect(await page.getByRole("heading", { name: "Customer support", exact: true }).evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await expect(catalogue.getByRole("heading", { name: "GitHub", exact: true })).toHaveCount(0);
    await catalogue.getByRole("button", { name: "Add Human support", exact: true }).click();
    expect(state.draft().tools).not.toContain("channel.request_handoff");
    await expect(page.getByRole("button", { name: "Create version", exact: true })).toHaveCount(0);
    await catalogue.getByRole("button", { name: "Added 3", exact: true }).click();
    await expect(catalogue.getByRole("article")).toHaveCount(3);
    await catalogue.getByRole("button", { name: "Available", exact: true }).click();
    await catalogue.getByRole("textbox", { name: "Search tools" }).fill("GitHub");
    await expect(catalogue.getByRole("article")).toHaveCount(1);
    await expect(catalogue.getByText("Connected tools are unavailable for this customer agent.")).toBeVisible();
    await expect(catalogue.getByRole("button", { name: /Connect|Add GitHub/ })).toHaveCount(0);
    await catalogue.getByRole("textbox", { name: "Search tools" }).fill("no matching tool");
    await expect(catalogue.getByText("No tools match your search")).toBeVisible();
    await catalogue.getByRole("textbox", { name: "Search tools" }).fill("");
    await page.getByRole("button", { name: "General", exact: true }).click();
    await page.getByRole("button", { name: "Tools", exact: true }).click();
    await expect(page.getByRole("button", { name: "Remove Human support", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
    expect(state.draft().tools).toContain("channel.request_handoff");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(process.cwd(), `../../../.audit/mock-agent-tools-${width}.png`), fullPage: true, animations: "disabled" });
    expect(state.errors).toEqual([]);
  });
}

test("mock transport: catalogue errors retry without changing the draft", async ({ page }) => {
  const state = await fixture(page, true);
  await page.goto("/app/agents/root?section=tools");
  await expect(page.getByRole("alert")).toContainText("Catalogue temporarily unavailable");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Knowledge search", exact: true })).toBeVisible();
  expect(state.draft()).toEqual(configuration);
});

test("mock transport: a selected revoked tool remains visible and offers reconnect", async ({ page }) => {
  const state=await fixture(page,false,{...configuration,connectedToolBindingIds:["binding","missing"]});
  await page.route("**/catalogue/tools?*",route=>route.fulfill({json:{...toolCatalogue,entries:[{
    ...catalogueItem("github","GitHub"),kind:"native_api",added:true,connectorId:"github",
    requires:{connectionProfiles:["github-public-read-v1"],permissions:[]},configuration:{tools:[],connectedToolBindingIds:["binding"],skillIds:[]},
    readiness:{state:"needs_connection",reasons:[{code:"CONNECTION_REVOKED",message:"The selected connection was revoked. Reconnect and review access."}]},
    action:{kind:"connect",connectionProfileId:"github-public-read-v1",connectionId:"connection"},
  }]}}));
  await page.goto("/app/agents/root?section=tools");
  const tool=page.getByRole("article").filter({has:page.getByRole("heading",{name:"GitHub",exact:true})});
  await expect(tool.getByText("The selected connection was revoked. Reconnect and review access.")).toBeVisible();
  await expect(tool.getByText("Added",{exact:true})).toBeVisible();
  await expect(tool.getByRole("button",{name:"Remove GitHub"})).toBeVisible();
  await expect(page.getByRole("button",{name:"Added 2",exact:true})).toBeVisible();
  await expect(page.getByRole("heading",{name:"Unlisted tool",exact:true})).toBeVisible();
  await expect(page.getByText("Selected · status unknown",{exact:true})).toBeVisible();
  for (const width of [1440,768,390]) {
    await page.setViewportSize({width,height:1000});
    await expect(tool.getByRole("button",{name:"Reconnect GitHub"})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }
  await page.getByRole("button",{name:"Remove unlisted tool"}).click();
  await expect(page.getByRole("button",{name:"Added 1",exact:true})).toBeVisible();
  await tool.getByRole("button",{name:"Reconnect GitHub"}).click();
  await expect(page).toHaveURL(/\/app\/connections\?/);
  expect(state.draft().connectedToolBindingIds).toEqual(["binding"]);
  expect(state.errors).toEqual([]);
});

test("mock transport: import, inspect, review and add a private skill revision", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/app/agents/root?section=skills");
  await page.getByRole("button", { name: "Import skill", exact: true }).click();
  await page.getByLabel("Skill file", { exact: true }).setInputFiles({ name: "SKILL.md", mimeType: "text/markdown", buffer: Buffer.from("---\nname: support-writing\ndescription: Write concise customer replies.\n---\nWrite plainly.") });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const preview = page.getByRole("dialog");
  await expect(preview.getByRole("heading", { name: "Support writing" })).toBeVisible();
  await expect(preview.getByText("Write plainly.", { exact: true })).toBeVisible();
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(process.cwd(), `../../../.audit/mock-skill-preview-${width}.png`), fullPage: true, animations: "disabled" });
  }
  await preview.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  await expect(preview.getByText("Reviewed", { exact: true })).toBeVisible();
  await preview.getByRole("button", { name: "Close", exact: true }).first().click();
  await page.getByRole("combobox", { name: "Library", exact: true }).selectOption("curated");
  await expect(page.getByRole("button", { name: "Add Support writing", exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Library", exact: true }).selectOption("private");
  await page.getByRole("button", { name: "Add Support writing", exact: true }).click();
  expect(state.draft().skillIds).toEqual([]);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect(state.draft().skillIds).toEqual(["skill1"]);
  expect(state.errors).toEqual([]);
});


test("mock transport: curated skill preview installs a real revision into the draft", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/app/agents/root?section=skills");
  await page.getByRole("combobox", { name: "Library", exact: true }).selectOption("curated");
  await expect(page.getByRole("button", { name: "Grounded answers", exact: true })).toBeVisible();
  for (const width of [1280, 390]) for (const theme of ["light", "dark"]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(value => document.documentElement.classList.toggle("dark", value === "dark"), theme);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(process.cwd(), `../../../.audit/catalogue-skills-${width}-${theme}.png`), animations: "disabled" });
  }
  await page.getByRole("button", { name: "Add Grounded answers", exact: true }).click();
  const preview = page.getByRole("dialog");
  await expect(preview.getByText("Cite approved knowledge.", { exact: true })).toBeVisible();
  expect(state.draft().skillIds).toEqual([]);
  await preview.getByRole("button", { name: "Add skill", exact: true }).click();
  await expect(preview).toBeHidden();
  await expect(page.getByRole("button", { name: "Remove Grounded answers", exact: true })).toBeVisible();
  expect(state.draft().skillIds).toEqual([]);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect(state.draft().skillIds).toEqual(["curated1"]);
});


test("mock transport: removing a saved tool restores its Add action before catalogue refresh", async ({ page }) => {
  await fixture(page);
  await page.goto("/app/agents/root?section=tools");
  await page.getByRole("button", { name: "Remove Knowledge search", exact: true }).click();
  await page.getByRole("button", { name: "Add Knowledge search", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove Knowledge search", exact: true })).toBeVisible();
});

test("mock transport: repository import pins an exact commit and preserves input on failure", async ({ page }) => {
  await fixture(page);
  let calls = 0;
  await page.route("**/skills/packages/repository", async route => {
    const body = route.request().postDataJSON(); calls++;
    expect(body).toMatchObject({ repository: "example/skills", commit: "a".repeat(40), path: "skills/replies" }); expect(body.operationId).toBeTruthy();
    await route.fulfill({ status: 400, json: { error: { message: "This commit does not contain a skill package." } } });
  });
  await page.goto("/app/agents/root?section=skills");
  await page.getByRole("button", { name: "Import skill", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox", { name: "Skill source" }).selectOption("repository");
  await dialog.getByRole("textbox", { name: "Repository", exact: true }).fill("example/skills");
  await dialog.getByRole("textbox", { name: "Commit SHA" }).fill("a".repeat(40));
  await dialog.getByRole("textbox", { name: "Package path" }).fill("skills/replies");
  await dialog.getByRole("button", { name: "Import", exact: true }).click();
  await expect(dialog.getByText("This commit does not contain a skill package.")).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "Commit SHA" })).toHaveValue("a".repeat(40));
  expect(calls).toBe(1);
});

test("mock transport: skill rollback replaces only the same publisher and source family draft", async ({ page }) => {
  const state = await fixture(page);
  const skill = (id: string, revision: number, familyId: string): SkillPackage => ({ id, name: "support-writing", description: "Write concise replies.", revision, familyId, contentDigest: id, compatibility: null, reviewState: "reviewed", state: "enabled", generation: 1, createdAt: "2026-10-20T00:00:00Z", files: [{ path: "SKILL.md", size: 3, contentDigest: id }], requires: { connectionProfiles: [], permissions: [], runtimes: [] } });
  const packages = [skill("new", 2, "familyA"), skill("old", 1, "familyA"), skill("other", 1, "familyB")];
  await page.route("**/catalogue/skills?*", route => route.fulfill({ json: { ...toolCatalogue, entries: packages.map(pkg => ({ ...catalogueItem(`skill:${pkg.id}`, pkg.name), familyId: pkg.familyId, kind: "skill", configuration: { tools: [], connectedToolBindingIds: [], skillIds: [pkg.id] } })) } }));
  await page.route("**/skills/packages**", route => {
    const url = new URL(route.request().url());
    const data = url.pathname.endsWith("/compare") ? { before: packages[0], after: packages[1], files: [{ path: "SKILL.md", change: "changed", beforeBytes: 4, afterBytes: 3 }], instructions: { before: "New instructions", after: "Old reviewed instructions" }, requirements: { before: packages[0].requires, after: packages[1].requires } } : url.pathname.endsWith("/new") ? { package: packages[0], body: "New instructions" } : { packages };
    return route.fulfill({ json: data });
  });
  await page.goto("/app/agents/root?section=skills");
  const rows = page.getByRole("article");
  await rows.nth(0).getByRole("button", { name: "Add Support writing", exact: true }).click();
  await rows.nth(2).getByRole("button", { name: "Add Support writing", exact: true }).click();
  await rows.nth(0).getByRole("button", { name: "Support writing", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByText("Compare revisions", { exact: true }).click();
  await dialog.getByRole("combobox", { name: "Compare revision" }).selectOption("old");
  expect(await dialog.getByRole("combobox", { name: "Compare revision" }).locator("option").count()).toBe(2);
  await dialog.getByRole("button", { name: "Compare", exact: true }).click();
  await expect(dialog.getByText("Old reviewed instructions")).toBeVisible();
  await dialog.getByRole("button", { name: "Use revision 1", exact: true }).click();
  expect(state.draft().skillIds).toEqual([]);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect(state.draft().skillIds).toEqual(["other", "old"]);
});

for (const saveFails of [false, true]) test(`mock transport: Connect ${saveFails ? "preserves the draft when save fails" : "saves the current draft before opening its exact connection"}`, async ({ page }) => {
  const state = await fixture(page);
  const connection = { ...catalogueItem("connection:remote1", "Support tools"), kind: "mcp", recommended: true, requires: { connectionProfiles: ["remote-mcp-v1"], permissions: [] }, readiness: { state: "needs_connection", reasons: [] }, action: { kind: "connect", connectionProfileId: "remote-mcp-v1", connectionId: "remote1" } };
  await page.route("**/catalogue/tools?*", route => route.fulfill({ json: { ...toolCatalogue, entries: [...toolCatalogue.entries, connection] } }));
  if (saveFails) await page.route("**/agents/root", route => route.request().method() === "PUT" ? route.fulfill({ status: 409, json: { error: { message: "The agent changed. Review your draft before saving." } } }) : route.fallback());
  for (const suffix of ["connections", "remote-connections", "api-connections"]) await page.route(`**/organizations/org/${suffix}`, route => route.fulfill({ json: suffix === "connections" ? { connections: [], targets: [], profiles: [] } : { connections: [] } }));
  await page.goto("/app/agents/root?section=tools");
  await page.getByRole("button", { name: "Add Human support", exact: true }).click();
  await page.getByRole("button", { name: "Connect Support tools", exact: true }).click();
  if (saveFails) {
    await expect(page.getByText("The agent changed. Review your draft before saving.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove Human support", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeEnabled();
    expect(new URL(page.url()).pathname).toBe("/app/agents/root"); expect(state.draft().tools).not.toContain("channel.request_handoff");
  } else {
    await page.waitForURL(url => url.pathname === "/app/connections");
    const url = new URL(page.url()); expect(url.searchParams.get("setup")).toBe("remote1"); expect(url.searchParams.get("returnTo")).toBe("/app/agents/root?section=tools");
    expect(state.draft().tools).toContain("channel.request_handoff");
  }
  await expect(page.getByRole("alertdialog")).toHaveCount(0); expect(state.errors).toEqual([]);
});

test("mock transport: Connect preserves newer selections made during its draft save", async ({ page }) => {
  const state = await fixture(page);
  let releaseSave!: () => void, saveStarted = false;
  const gate = new Promise<void>(resolve => { releaseSave = resolve; });
  await page.route("**/agents/root", async route => { if (route.request().method() === "PUT" && !saveStarted) { saveStarted = true; await gate; } await route.fallback(); });
  await page.route("**/catalogue/tools?*", route => route.fulfill({ json: { ...toolCatalogue, entries: [...toolCatalogue.entries, { ...catalogueItem("remote", "Support tools"), recommended: true, requires: { connectionProfiles: ["remote-mcp-v1"], permissions: [] }, readiness: { state: "needs_connection", reasons: [] }, action: { kind: "connect", connectionProfileId: "remote-mcp-v1" } }] } }));
  await page.goto("/app/agents/root?section=tools");
  await page.getByRole("button", { name: "Add Human support", exact: true }).click();
  await page.getByRole("button", { name: "Connect Support tools", exact: true }).click();
  await expect.poll(() => saveStarted).toBe(true);
  await page.getByRole("button", { name: "Remove Knowledge search", exact: true }).click(); releaseSave();
  await expect(page.getByText("You have more unsaved changes. Connect again to save them.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add Knowledge search", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove Human support", exact: true })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/app/agents/root");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect(state.draft().tools).toContain("channel.request_handoff"); expect(state.draft().tools).not.toContain("knowledge.search");
});

test("mock transport: Google Calendar removal edits only the booking policy draft and Configure opens General", async ({ page }) => {
  const state = await fixture(page);
  const draft = { ...structuredClone(configuration), capabilities: { ...configuration.capabilities, businessActions: { enabled: true, profileId: "calendar-booking-v1", permittedOperations:["calendar.availability","calendar.book"], policyId: "policy1", policyDigest: "policy-digest" } } };
  await page.route("**/agents/root", route => route.request().method() === "GET" ? route.fulfill({ json: { agent: { id: "root", name: "Customer support", offering: "faq", draft, draftRevision: 1 }, versions: [], deployments: [] } }) : route.fallback());
  await page.route("**/catalogue/tools?*", route => route.fulfill({ json: { ...toolCatalogue, entries: [{ ...catalogueItem("google-calendar", "Google Calendar"), selection:{kind:"capability",capability:"businessActions",profileId:"calendar-booking-v1",setup:"booking"}, added: true, requires: { connectionProfiles: ["google-calendar-v1"], permissions: [] }, readiness: { state: "needs_configuration", reasons: [] }, action: { kind: "configure", connectionProfileId: "google-calendar-v1", configurationSection: "configuration",configurationSetup:"booking" } }] } }));
  await page.route("**/booking-policies", route => route.fulfill({ json: { policies: [] } }));
  await page.route("**/google-calendar/connections", route => route.fulfill({ json: { connections: [] } }));
  await page.goto("/app/agents/root?section=tools");
  await expect(page.getByRole("button", { name: "Configure Google Calendar", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Remove Google Calendar", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove Google Calendar", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add Google Calendar", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Configure Google Calendar", exact: true }).click();
  expect(new URL(page.url()).searchParams.get("section")).toBe("configuration"); expect(new URL(page.url()).searchParams.get("setup")).toBe("booking");
  await expect(page.getByRole("region", { name: "Booking policy", exact: true })).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save changes", exact: true })).toBeDisabled();
  expect(state.draft().capabilities.businessActions).toEqual({ enabled: false });
  expect(state.draft().tools).toEqual(configuration.tools); expect(state.draft().connectedToolBindingIds).toEqual([]);
});
