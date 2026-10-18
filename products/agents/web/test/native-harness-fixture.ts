import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import type { Agent, CapabilityBinding, Configuration, KnowledgeSources, Session, Version } from "../src/platform/api";

// Shared-harness acceptance provisions capabilities through the normal authenticated API.
// The standalone customer editor deliberately exposes no research or personal-memory controls.
export async function nativeJson<T>(page: Page, path: string, method = "GET", data?: unknown): Promise<T> {
  const response = await page.request.fetch(path, { method, data, headers: { origin: new URL(page.url()).origin } });
  expect(response.ok(), `${method} ${path}: ${response.status()}`).toBe(true);
  return response.json() as Promise<T>;
}
export async function nativeAgent(page: Page) {
  const agentId = new URL(page.url()).pathname.match(/^\/app\/agents\/([^/]+)/)?.[1];
  expect(agentId, "The fixture must select its own agent").toBeTruthy();
  const session = await nativeJson<Session>(page, "/api/session"), selected = await page.evaluate(() => sessionStorage.getItem("agents.organization"));
  const organization = session.organizations.find(item => item.id === selected) ?? session.organizations[0];
  expect(organization).toBeDefined();
  const base = `/api/organizations/${encodeURIComponent(organization.id)}`, path = `${base}/agents/${encodeURIComponent(agentId!)}`;
  return { base, path, ...await nativeJson<{ agent: Agent; versions: Version[] }>(page, path) };
}
export async function saveNativeProgram(page: Page, configuration: Configuration) {
  const current = await nativeAgent(page);
  return nativeJson<{ agent: Agent }>(page, current.path, "PUT", { name: current.agent.name, configuration, expectedRevision: current.agent.draftRevision });
}
export async function prepareNativeSpecialists(page: Page, options: { versionIds: string[]; sourceTitles?: string[]; operations?: string[][]; maxTokens?: number; knowledge?: boolean; workflow?: Configuration["capabilities"]["workflows"] }) {
  expect(options.versionIds).toHaveLength(2);
  const current = await nativeAgent(page), agents = await nativeJson<{ agents: Agent[] }>(page, `${current.base}/agents`);
  const published = (await Promise.all(agents.agents.map(agent => nativeJson<{ versions: Version[] }>(page, `${current.base}/agents/${encodeURIComponent(agent.id)}`)))).flatMap(item => item.versions);
  const sources = await nativeJson<KnowledgeSources>(page, `${current.base}/knowledge/sources`), tools = await nativeJson<{ bindings: CapabilityBinding[] }>(page, `${current.base}/tool-bindings`);
  const bindings = options.versionIds.map((versionId, position) => {
    const version = published.find(item => item.id === versionId); expect(version, "The explicitly selected specialist version must exist").toBeDefined();
    const title = options.sourceTitles?.[position];
    const source = title ? sources.sources.find(item => item.title === title && item.state === "active") : undefined;
    if (title) expect(source, "The fixture source must remain available").toBeDefined();
    const sourceRevisionIds = source?.revisions.filter(revision => revision.state === "approved" && current.agent.draft.sourceRevisionIds?.includes(revision.id) && version!.configuration.sourceRevisionIds?.includes(revision.id)).map(revision => revision.id) ?? [];
    if (title) expect(sourceRevisionIds.length).toBeGreaterThan(0);
    const connectedToolBindingIds = (options.operations?.[position] ?? []).map(operation => {
      const binding = tools.bindings.find(item => item.definition.providerOperation === operation && version!.configuration.connectedToolBindingIds?.includes(item.id));
      expect(binding, `Selected specialist operation ${operation} must be published`).toBeDefined(); return binding!.id;
    });
    return { id: randomUUID(), versionId, sourceRevisionIds, connectedToolBindingIds, tools: options.knowledge === false || !sourceRevisionIds.length ? [] : ["knowledge.search" as const, "knowledge.read" as const], maxTokens: options.maxTokens ?? 8000, maxActiveMs: 240000 };
  });
  const configuration: Configuration = { ...current.agent.draft, program: { id: "tool-directed", version: "1" }, tools: ["agents.delegate", "sandbox.analyze"], capabilities: { ...current.agent.draft.capabilities,
    delegation: { enabled: true, bindings, maxChildren: 2, maxDepth: 1 }, sandbox: { enabled: true, profileId: "python-analysis-v1" }, ...(options.workflow ? { workflows: options.workflow } : {}) } };
  await saveNativeProgram(page, configuration); return configuration;
}
