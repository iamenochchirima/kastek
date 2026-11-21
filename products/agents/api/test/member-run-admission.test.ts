import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { defaultBusinessConfiguration, requestDigest, type AdmissionAuthority } from "../src/contracts/contracts";
import { admitMemberRun } from "../src/platform/runs/member-admission";

vi.mock("../src/infrastructure/database", () => ({
  transaction: async (pool: unknown, work: (db: unknown) => Promise<unknown>) => work(pool),
}));

describe("member run admission", () => {
  const authority: AdmissionAuthority = { product: "agents", organizationId: randomUUID(), resourceId: randomUUID(),
    callerClientId: "agents-execution", principal: { kind: "human", issuer: "https://identity.test", subject: "member" } };
  const input = { authority, accountId: randomUUID(), message: "Hello", requestKey: "request-1" };

  it("pins the current version and creates the grant before admission", async () => {
    const version = { id: randomUUID(), configuration: defaultBusinessConfiguration() };
    const query = vi.fn().mockResolvedValueOnce({ rowCount: 1 }).mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [version] });
    const createGrantInTransaction = vi.fn().mockImplementation(async (_db, value) => value.grant);
    const admitTaskInTransaction = vi.fn().mockResolvedValue({ task: { id: "task" }, replayed: false });
    const assertServices = vi.fn().mockResolvedValue(undefined);
    const onAdmitted = vi.fn().mockResolvedValue(undefined);
    const result = await admitMemberRun({ pool: { query } as unknown as Pool,
      store: { createGrantInTransaction, admitTaskInTransaction }, assertServices, grantOperations: () => ["model.reply"], onAdmitted }, input);
    expect(result.replayed).toBe(false);
    const grant = createGrantInTransaction.mock.calls[0]![1].grant;
    expect(grant.versionId).toBe(version.id);
    expect(admitTaskInTransaction).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      authority, versionId: version.id, grantId: grant.id, input: "Hello", configurationMode: "current",
    }));
    expect(createGrantInTransaction.mock.invocationCallOrder[0]).toBeLessThan(admitTaskInTransaction.mock.invocationCallOrder[0]!);
    expect(onAdmitted).toHaveBeenCalledWith(expect.anything(), result);
  });

  it("replays an identical request without issuing another grant and rejects changed input", async () => {
    const versionId = randomUUID();
    const existing = { version_id: versionId, conversation_id: randomUUID(), request_digest: requestDigest({ authority,
      versionId, input: input.message, conversationId: null, evaluationTrialId: null, channelBinding: null }) };
    const query = vi.fn(async (sql: string) => sql.includes("FROM agents_platform.tasks") ? { rows: [existing] } :
      sql.includes("deleted_at FROM") ? { rows: [{ deleted_at: null }] } : { rowCount: 1 });
    const createGrantInTransaction = vi.fn();
    const options = { pool: { query } as unknown as Pool, store: { createGrantInTransaction, admitTaskInTransaction: vi.fn() },
      assertServices: vi.fn(), grantOperations: () => [] };
    expect((await admitMemberRun(options, input)).replayed).toBe(true);
    await expect(admitMemberRun(options, { ...input, message: "Changed" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    expect(createGrantInTransaction).not.toHaveBeenCalled();
  });
});
