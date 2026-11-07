import test from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { readGrowthAgentContext, assertGrowthAgentContext,growthAgentContextModelView } from "../src/agents/scope.js";
import { growthAgentDigest } from "../src/agents/security.js";
import { readConfig } from "../src/config.js";
import type { CoreContext } from "../src/context.js";
test("selected content context hides account/job fields while its revision covers the full source",()=>{
  const context={kind:"content_post" as const,resourceId:"draft"},source={id:"draft",title:"Draft",content:"Useful copy",channels:["FACEBOOK"],status:"DRAFT",
    selectedAccounts:[{platform:"FACEBOOK",accountId:null,status:"PENDING"}]};
  const first=growthAgentContextModelView(context,source);
  assert.equal(first.revision,growthAgentDigest(source));
  assert.deepEqual(first.data,{id:"draft",title:"Draft",content:"Useful copy",channels:["FACEBOOK"],status:"DRAFT"});
  assert(!JSON.stringify(first.data).includes("PENDING"));
  const changed=growthAgentContextModelView(context,{...source,selectedAccounts:[{platform:"FACEBOOK",accountId:null,status:"QUEUED"}]});
  assert.notEqual(changed.revision,first.revision);
});
test("workspace guidance is sourced, bounded, permission-filtered and changes its accepted revision", async () => {
  const allowed = new Set(["feature.agents.manage", "feature.content.manage"]), queries: string[] = [];
  let member = true;
  const core = { config: readConfig({ DATABASE_URL: "postgres://unused" }), pool: { query: async (query: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
    const sql = typeof query === "string" ? query : query.text, args = typeof query === "string" ? values : query.values;
    queries.push(sql);
    if (sql.includes('FROM "OrganizationMember"')) return { rows: member ? [{ name: "Scoped business" }] : [] };
    if (sql.includes('LEFT JOIN "OrganizationOnboardingProfile"')) return { rows: [{ id: "business", name: "Scoped business", website: "https://example.test" }] };
    if (sql.includes('WITH candidate AS')) return { rows: [[allowed.has(String(args?.[1]))]] };
    throw new Error("Unexpected guidance query");
  } } } as unknown as CoreContext;
  const scope = { tenantId: "business", actor: { issuer: "https://growth.kasitek.co.za/identity", subject: "user" } }, context = { kind: "workspace" as const };
  try {
    const evidence = await readGrowthAgentContext(core, scope, context), data = evidence.data as { name: string; website: string; productGuide: { pages: { route: string }[]; unavailableAgentActions: string[] } };
    assert.equal(data.name, "Scoped business"); assert.equal(data.website, "https://example.test");
    assert.deepEqual(data.productGuide.pages.map(page => page.route), ["/agents", "/workspace/settings", "/content/posts"]);
    assert(data.productGuide.unavailableAgentActions.includes("External web research")); assert(Buffer.byteLength(JSON.stringify(data.productGuide)) < 4096);
    for (const page of data.productGuide.pages) await access(new URL(`../../web/src/app/(dashboard)${page.route}/page.tsx`, import.meta.url));
    assert(queries.every(sql => !sql.includes("BusinessProfile")));
    allowed.delete("feature.content.manage");
    scope.tenantId = "business-denied";
    await assert.rejects(assertGrowthAgentContext(core, scope, context, evidence.revision), /attached record changed/);
    const changed = await readGrowthAgentContext(core, scope, context); assert.notEqual(changed.revision, evidence.revision);
    member = false; await assert.rejects(readGrowthAgentContext(core, scope, context), /Business access is unavailable/);
  } finally {}
});
test("analytics context requires the current report entitlement before any gateway request", async () => {
  const core = { config: readConfig({ DATABASE_URL: "postgres://unused" }), pool: { query: async (query: string | { text: string; values?: unknown[] }, values?: unknown[]) => {
    const sql = typeof query === "string" ? query : query.text, args = typeof query === "string" ? values : query.values;
    if (sql.includes('FROM "OrganizationMember"')) return { rows: [{ name: "Business" }] };
    if (sql.includes('WITH candidate AS')) return { rows: [[args?.[1] === "feature.agents.manage"]] };
    throw new Error("Unauthorized report read attempted");
  } } } as unknown as CoreContext;
  const scope = { tenantId: "business", actor: { issuer: "https://growth.kasitek.co.za/identity", subject: "user" } }, context = { kind: "analytics_report" as const, range: { from: "2026-10-01", to: "2026-10-02", timezone: "UTC" } };
  try { await assert.rejects(readGrowthAgentContext(core, scope, context), /Analytics is not included/); await assert.rejects(assertGrowthAgentContext(core, scope, context), /Analytics is not included/); }
  finally {}
});
