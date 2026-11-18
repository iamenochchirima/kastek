import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { WorkflowRevisions } from "../src/execution/procedures/workflow-revisions";
import { PlatformStore } from "../src/product/agents/store";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("declarative workflow revisions", () => {
  let admin: Pool, pool: Pool;
  const database = `agents_workflows_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url }); await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href }); await setupPlatformSchema(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });

  it("publishes, lists, assigns and completes a custom revision", async () => {
    const store = new PlatformStore(pool);
    const owner = await store.ensureAccount({ issuer: "https://identity.test", subject: randomUUID(), email: "workflows@example.test", displayName: "Owner" });
    const org = await store.createOrganization(owner.id, "Workflows");
    const revisions = new WorkflowRevisions(pool);
    const scope = { accountId: owner.id, organizationId: org.id };
    const published = await revisions.publish(scope, {
      id: "custom-checkin", title: "Custom check-in", description: "Check in after a service request.",
      prerequisites: ["support.get_status_v2"], waits: [{ kind: "customer_choice", description: "The customer confirms the check-in." }],
      completionEvidence: [{ kind: "assistant_reply", required: true }, { kind: "customer_choice", required: true }],
    });
    expect(published.version).toBe("1");
    expect((await revisions.list(scope)).map(item => `${item.id}@${item.version}`)).toContain("custom-checkin@1");
    const definition = await revisions.definition(pool, org.id, { id: "custom-checkin", version: "1" });
    expect(definition?.metadata.prerequisites).toEqual(["support.get_status_v2"]);
    expect(definition?.metadata.waits?.[0]?.kind).toBe("customer_choice");
    expect(definition?.progress(null, []).missing).toEqual(["customer_choice", "assistant_reply"]);
    expect(definition?.progress("checkin", [
      { kind: "assistant_reply", sourceId: "reply", status: "confirmed" },
      { kind: "customer_choice", sourceId: "choice", status: "confirmed" },
    ]).complete).toBe(true);

    const configuration = { ...defaultBusinessConfiguration(), tools: ["channel.request_handoff", "support.get_status_v2"] as const,
      supportHours: { timeZone: "Africa/Johannesburg", intervals: [{ day: 1, start: "09:00", end: "17:00" }] },
      procedures: [{ id: "custom-checkin", version: "1" }] };
    const agent = await store.createConfiguredAgent({ accountId: owner.id, organizationId: org.id, name: "Workflow agent", configuration });
    const version = await store.createVersion({ accountId: owner.id, organizationId: org.id, agentId: agent.agent.id, expectedRevision: 1 });
    expect(JSON.stringify(version.effective_composition)).toContain("custom-checkin");
    expect(version.configuration.procedures).toEqual([{ id: "custom-checkin", version: "1" }]);
  });
});
