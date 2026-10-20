import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, expect, type Page } from "@playwright/test";

type Fixture = { url: string; organizationId: string; agentId: string; otherAgentId: string; cookie: string };
type AgentResponse = { agent: { draft: { skillIds: string[]; tools: string[] }; draftRevision: number }; versions: { id: string; number: number; configuration: { skillIds: string[] } }[] };
const fixturePath = process.env.AGENTS_CATALOGUE_BROWSER_STATE;
test.skip(!fixturePath, "Run through the isolated actual API catalogue browser fixture");

async function currentAgent(page: Page, fixture: Fixture, agentId = fixture.agentId) {
  const response = await page.request.get(`${fixture.url}/api/organizations/${fixture.organizationId}/agents/${agentId}`);
  expect(response.status()).toBe(200); return response.json() as Promise<AgentResponse>;
}

test("actual API: curated and private skill revisions survive save, reload and immutable publication", async ({ page, context }) => {
  const fixture: Fixture = JSON.parse(await readFile(fixturePath!, "utf8"));
  await context.addCookies([{ name: "agents_session", value: fixture.cookie, url: fixture.url, httpOnly: true, sameSite: "Lax" }]);
  const errors: string[] = [], failures: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (new URL(response.url()).pathname.startsWith("/api/") && response.status() >= 400) failures.push(`${response.status()} ${new URL(response.url()).pathname}`); });
  const agentPath = `${fixture.url}/app/agents/${fixture.agentId}`;
  await page.goto(`${agentPath}?section=tools`);
  const tools = page.getByRole("region", { name: "Tools catalogue", exact: true });
  await expect(tools.getByRole("heading", { name: "Human support", exact: true })).toBeVisible();
  await expect(tools.getByRole("button", { name: "Remove Human support", exact: true })).toBeVisible();
  await tools.getByRole("button", { name: "Remove Human support", exact: true }).click();
  expect((await currentAgent(page, fixture)).agent.draft.tools).toContain("channel.request_handoff");
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save configuration", exact: true })).toBeDisabled();
  expect((await currentAgent(page, fixture)).agent.draft.tools).not.toContain("channel.request_handoff");
  await tools.getByRole("button", { name: "Add Human support", exact: true }).click();
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save configuration", exact: true })).toBeDisabled();

  await page.getByRole("button", { name: "Skills", exact: true }).click();
  await page.getByRole("combobox", { name: "Library", exact: true }).selectOption("curated");
  const catalogue = page.getByRole("region", { name: "Skills catalogue", exact: true });
  const curatedName = "grounded-answers";
  await catalogue.getByRole("button", { name: `Add ${curatedName}`, exact: true }).click();
  const preview = page.getByRole("dialog");
  await expect(preview.getByRole("heading", { name: curatedName, exact: true })).toBeVisible();
  await expect(preview.locator("pre")).not.toBeEmpty();
  const installResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/skills/curated/grounded-answers/install") && response.request().method() === "POST");
  await preview.getByRole("button", { name: "Add skill", exact: true }).click();
  const installed = (await (await installResponse).json()).package;
  expect(installed.id).toMatch(/^[0-9a-f-]{36}$/); expect(installed.reviewState).toBe("reviewed"); expect(installed.publisher.verified).toBe(true);
  expect((await currentAgent(page, fixture)).agent.draft.skillIds).toEqual([]);
  await expect(page.getByRole("button", { name: "Create version", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save configuration", exact: true })).toBeDisabled();
  expect((await currentAgent(page, fixture)).agent.draft.skillIds).toEqual([installed.id]);
  await page.reload();
  await catalogue.getByRole("button", { name: "Added 1", exact: true }).click();
  await expect(catalogue.getByRole("button", { name: `Remove ${curatedName}`, exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Import skill", exact: true }).click();
  await page.getByLabel("Skill file", { exact: true }).setInputFiles({ name: "SKILL.md", mimeType: "text/markdown", buffer: Buffer.from("---\nname: acceptance-replies\ndescription: Write concise support replies.\n---\nWrite clearly. Cite approved sources and ask for clarification when needed.") });
  const importResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith("/skills/packages") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Import", exact: true }).click();
  const imported = (await (await importResponse).json()).package;
  expect(imported.reviewState).toBe("pending"); expect(imported.publisher.verified).toBe(false);
  await expect(preview.getByRole("heading", { name: "acceptance-replies", exact: true })).toBeVisible();
  await expect(preview.locator("pre")).toContainText("Write clearly.");
  const reviewResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith(`/skills/packages/${imported.id}/review`));
  await preview.getByRole("button", { name: "Mark reviewed", exact: true }).click();
  const review = await reviewResponse;
  expect(review.request().postDataJSON()).toEqual({ contentDigest: imported.contentDigest });
  expect((await review.json()).package.reviewState).toBe("reviewed");
  await preview.getByRole("button", { name: "Close", exact: true }).first().click();
  await expect(page.getByRole("combobox", { name: "Library", exact: true })).toHaveValue("private");
  await catalogue.getByRole("button", { name: "Add acceptance-replies", exact: true }).click();
  expect((await currentAgent(page, fixture)).agent.draft.skillIds).toEqual([installed.id]);
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save configuration", exact: true })).toBeDisabled();
  const expectedIds = [installed.id, imported.id];
  expect((await currentAgent(page, fixture)).agent.draft.skillIds).toEqual(expectedIds);
  await page.getByRole("button", { name: "Create version", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Version", exact: true })).toHaveValue(/.+/);
  const published = await currentAgent(page, fixture);
  expect(published.versions).toHaveLength(1); expect(published.versions[0]!.configuration.skillIds).toEqual(expectedIds);
  await page.reload();
  await catalogue.getByRole("button", { name: "Added 2", exact: true }).click();
  await expect(catalogue.getByRole("article")).toHaveCount(2);
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: resolve(process.cwd(), `../../../.audit/actual-api-skills-${width}.png`), fullPage: true, animations: "disabled" });
  }
  await catalogue.getByRole("button", { name: "Remove acceptance-replies", exact: true }).click();
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  await expect(page.getByRole("button", { name: "Save configuration", exact: true })).toBeDisabled();
  const changed = await currentAgent(page, fixture);
  expect(changed.agent.draft.skillIds).toEqual([installed.id]); expect(changed.versions[0]!.configuration.skillIds).toEqual(expectedIds);
  expect((await currentAgent(page, fixture, fixture.otherAgentId)).agent.draft.skillIds).toEqual([]);
  await page.goto(`${fixture.url}/app/agents/${fixture.otherAgentId}?section=skills`);
  await page.getByRole("combobox", { name: "Library", exact: true }).selectOption("private");
  await expect(page.getByRole("button", { name: "Add acceptance-replies", exact: true })).toHaveCount(0);
  expect(errors).toEqual([]); expect(failures).toEqual([]);
});
