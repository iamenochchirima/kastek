import { test, expect, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { agentSummary } from "./workspace-fixtures";
import { catalogueItem, toolCatalogue } from "./catalogue-fixtures";
import type { Catalogue, Configuration, SkillPackage } from "../src/platform/api";

const configuration: Configuration = { executionKind: "business", instructions: "Answer from approved knowledge.", model: { provider: "openrouter", model: "nvidia/nemotron-3-super-120b-a12b:free", maxInputBytes: 16384, maxOutputTokens: 1024, maxDurationSeconds: 120 }, tools: ["knowledge.search", "knowledge.read"], skillIds: [], connectedToolBindingIds: [], capabilities: { delegation: { enabled: false }, sandbox: { enabled: false }, businessActions: { enabled: false }, workflows: { enabled: false }, schedules: { enabled: false } } };
async function fixture(page: Page, failInitially = false) {
  let draft = structuredClone(configuration), revision = 1, calls = 0;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const github = { ...catalogueItem("github", "GitHub"), kind: "native_api" as const, recommended: false, requires: { connectionProfiles: ["github-public-read-v1"], permissions: [] }, readiness: { state: "unavailable" as const, reasons: [{ code: "CUSTOMER_TOOL_UNSUPPORTED", message: "Connected tools are unavailable for this customer agent." }] }, action: { kind: "none" as const } };
  const skill: SkillPackage = { id: "skill1", name: "support-writing", description: "Write concise customer replies.", revision: 1, contentDigest: "sha256:skill-digest", compatibility: null, reviewState: "pending", createdAt: "2026-10-20T00:00:00Z", files: [{ path: "SKILL.md", size: 80, contentDigest: "file-digest" }] };
  let imported = false, reviewed = false, curatedInstalled = false;
  await page.route("**/api/**", async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    let data: unknown;
    if (path === "/api/session") data = { account: { id: "owner", email: "owner@example.test", displayName: "Owner" }, organizations: [{ id: "org", name: "Support", role: "owner" }] };
    else if (path.endsWith("/knowledge/sources")) data = { sources: [], imports: [] };
    else if (path.endsWith("/agents/root")) {
      if (request.method() === "PUT") { expect(request.postDataJSON().expectedRevision).toBe(revision); draft = request.postDataJSON().configuration; revision++; }
      data = { agent: { id: "root", name: "Customer support", offering: "faq", draft, draftRevision: revision }, versions: [], deployments: [] };
    } else if (path.endsWith("/agents/summaries")) data = { agents: [agentSummary({ id: "root", name: "Customer support", draftRevision: revision })], nextCursor: null };
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
      const curated = { ...catalogueItem("curated:grounded-answers", "Grounded answers"), kind: "skill" as const, source: { kind: "curated" as const, slug: "grounded-answers" }, configuration: { tools: [], connectedToolBindingIds: [], skillIds: curatedInstalled ? ["curated1"] : [] } };
      data = { ...toolCatalogue, entries: [curated, ...(imported ? [entry] : [])] } as Catalogue;
    } else if (path.endsWith("/skills/curated/grounded-answers/install")) {
      expect(request.postDataJSON().operationId).toBeTruthy(); curatedInstalled = true;
      data = { package: { ...skill, id: "curated1", name: "Grounded answers", reviewState: "reviewed" } };
    } else if (path.endsWith("/skills/curated/grounded-answers")) data = { skill: { name: "Grounded answers", description: "Answer from approved sources.", compatibility: null }, body: "Cite approved knowledge." };
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
    await expect(catalogue.getByRole("heading", { name: "GitHub", exact: true })).toHaveCount(0);
    await catalogue.getByRole("button", { name: "Add Human support", exact: true }).click();
    expect(state.draft().tools).not.toContain("channel.request_handoff");
    await expect(page.getByRole("button", { name: "Create version", exact: true })).toBeDisabled();
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
    await page.getByRole("button", { name: "Save configuration", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save configuration", exact: true })).toBeDisabled();
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

test("mock transport: import, inspect, review and add a private skill revision", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/app/agents/root?section=skills");
  await page.getByRole("button", { name: "Import skill", exact: true }).click();
  await page.getByLabel("Skill file", { exact: true }).setInputFiles({ name: "SKILL.md", mimeType: "text/markdown", buffer: Buffer.from("---\nname: support-writing\ndescription: Write concise customer replies.\n---\nWrite plainly.") });
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const preview = page.getByRole("dialog");
  await expect(preview.getByRole("heading", { name: "support-writing" })).toBeVisible();
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
  await expect(page.getByRole("button", { name: "Add support-writing", exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Library", exact: true }).selectOption("private");
  await page.getByRole("button", { name: "Add support-writing", exact: true }).click();
  expect(state.draft().skillIds).toEqual([]);
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save configuration", exact: true })).toBeDisabled();
  expect(state.draft().skillIds).toEqual(["skill1"]);
  expect(state.errors).toEqual([]);
});


test("mock transport: curated skill preview installs a real revision into the draft", async ({ page }) => {
  const state = await fixture(page);
  await page.goto("/app/agents/root?section=skills");
  await page.getByRole("combobox", { name: "Library", exact: true }).selectOption("curated");
  await page.getByRole("button", { name: "Add Grounded answers", exact: true }).click();
  const preview = page.getByRole("dialog");
  await expect(preview.getByText("Cite approved knowledge.", { exact: true })).toBeVisible();
  expect(state.draft().skillIds).toEqual([]);
  await preview.getByRole("button", { name: "Add skill", exact: true }).click();
  await expect(preview).toBeHidden();
  await expect(page.getByRole("button", { name: "Remove Grounded answers", exact: true })).toBeVisible();
  expect(state.draft().skillIds).toEqual([]);
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save configuration", exact: true })).toBeDisabled();
  expect(state.draft().skillIds).toEqual(["curated1"]);
});


test("mock transport: removing a saved tool restores its Add action before catalogue refresh", async ({ page }) => {
  await fixture(page);
  await page.goto("/app/agents/root?section=tools");
  await page.getByRole("button", { name: "Remove Knowledge search", exact: true }).click();
  await page.getByRole("button", { name: "Add Knowledge search", exact: true }).click();
  await expect(page.getByRole("button", { name: "Remove Knowledge search", exact: true })).toBeVisible();
});
