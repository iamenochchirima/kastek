import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { Agent, Configuration, Memory, Skill, Version } from "../src/platform/api";
import { nativeAgent, nativeJson, prepareNativeSpecialists, saveNativeProgram } from "./native-harness-fixture";

// Runs only in the owned browser fixture when explicitly selected. It submits no model work.
test("live native provisioning: shared harness setup uses authenticated contracts without customer editor controls", async ({ page, context, baseURL }) => {
  const cookie = process.env.AGENTS_BROWSER_SESSION_COOKIE;
  test.skip(!cookie, "Requires an owned authenticated native fixture.");
  const separator = cookie!.indexOf("=");
  await context.addCookies([{ name: separator > 0 ? cookie!.slice(0, separator) : "agents_session", value: separator > 0 ? cookie!.slice(separator + 1) : cookie!, url: baseURL!, httpOnly: true, sameSite: "Lax" }]);
  await page.goto("/app/agents");
  if (await page.getByRole("combobox", { name: "Workspace", exact: true }).count()) await page.getByRole("combobox", { name: "Workspace", exact: true }).selectOption("new");
  else await page.getByRole("button", { name: "Create workspace", exact: true }).click();
  await page.getByRole("textbox", { name: "Workspace name", exact: true }).fill(`Native setup ${Date.now()}`);
  await page.getByRole("dialog").getByRole("button", { name: "Create workspace", exact: true }).click();
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Shared harness fixture");
  await page.getByRole("combobox", { name: "Agent type", exact: true }).selectOption("customer-service");
  await page.getByRole("dialog").getByRole("button", { name: "Create agent", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Instructions", exact: true })).toBeVisible();
  const current = await nativeAgent(page); expect(current.agent.offering).toBe("customer-service");
  await saveNativeProgram(page, { ...current.agent.draft, program: { id: "tool-directed", version: "1" }, memory: { enabled: true }, tools: ["memory.search", "memory.propose"] });
  const candidate = await nativeJson<Memory>(page, `${current.path}/memory`, "POST", { operationId: randomUUID(), kind: "semantic", content: "Use concise replies." });
  const accepted = await nativeJson<Memory>(page, `${current.path}/memory/candidates/${candidate.id}/accept`, "POST", { operationId: randomUUID(), expectedRevision: candidate.revision });
  const { skill } = await nativeJson<{ skill: Skill }>(page, `${current.path}/skills`, "POST", { operationId: randomUUID(), name: `brief-${Date.now()}`, description: "Use a short response.", body: "Use one short factual sentence." });
  await saveNativeProgram(page, { ...current.agent.draft, program: { id: "tool-directed", version: "1" }, memory: { enabled: true }, tools: ["memory.search", "memory.propose"], skillIds: [skill.id] });
  const versionIds: string[] = [];
  for (const name of ["Researcher", "Reviewer"]) {
    const { agent } = await nativeJson<{ agent: Agent }>(page, `${current.base}/agents`, "POST", { name });
    const configuration: Configuration = { ...agent.draft, program: { id: "tool-directed", version: "1" }, tools: [] };
    const saved = await nativeJson<{ agent: Agent }>(page, `${current.base}/agents/${agent.id}`, "PUT", { name, configuration, expectedRevision: agent.draftRevision });
    const { version } = await nativeJson<{ version: Version }>(page, `${current.base}/agents/${agent.id}/versions`, "POST", { expectedRevision: saved.agent.draftRevision }); versionIds.push(version.id);
  }
  await prepareNativeSpecialists(page, { versionIds });
  const configured = await nativeAgent(page);
  expect(configured.agent.draft).toMatchObject({ program: { id: "tool-directed", version: "1" }, skillIds: [skill.id], capabilities: { sandbox: { enabled: true }, delegation: { enabled: true, bindings: versionIds.map(versionId => ({ versionId, sourceRevisionIds: [], connectedToolBindingIds: [], tools: [] })) } } });
  const published = await nativeJson<{ version: Version }>(page, `${current.path}/versions`, "POST", { expectedRevision: configured.agent.draftRevision });
  expect(published.version.configuration.capabilities).toMatchObject(configured.agent.draft.capabilities);
  const pinnedDelegation = published.version.configuration.capabilities.delegation;
  expect(pinnedDelegation.enabled).toBe(true);
  if (pinnedDelegation.enabled) expect(pinnedDelegation.bindings.map(binding => [binding.label, binding.versionNumber])).toEqual([["Researcher", 1], ["Reviewer", 1]]);
  const corrected = await nativeJson<Memory>(page, `${current.path}/memory/${accepted.id}`, "PATCH", { operationId: randomUUID(), expectedRevision: accepted.revision, content: "Use detailed replies." });
  expect((await nativeJson<{ items: Memory[] }>(page, `${current.path}/memory`)).items.find(item => item.id === accepted.id)?.content).toBe("Use detailed replies.");
  await nativeJson<Memory>(page, `${current.path}/memory/${corrected.id}/forget`, "POST", { operationId: randomUUID(), expectedRevision: corrected.revision });
  expect((await nativeJson<{ items: Memory[] }>(page, `${current.path}/memory`)).items).toEqual([]);
  await page.reload(); await expect(page.getByRole("textbox", { name: "Instructions", exact: true })).toBeVisible();
  await expect(page.getByRole("checkbox", { name: "Delegate to specialists", exact: true })).toHaveCount(0);
});
