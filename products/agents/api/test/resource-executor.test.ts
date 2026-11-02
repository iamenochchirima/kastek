import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { createExecutorHost } from "../src/adapters/executors/executor-host";
import { ExecutorClient } from "../src/adapters/executors/executor-client";
import { executorSignature, type ExecutorRequest } from "../src/contracts/executor";
import { dropClosedTestDatabase } from "./support/database-cleanup";

(process.env.AGENTS_TEST_DATABASE_URL ? describe : describe.skip)("signed physical executor protocol and persistent command boundaries", () => {
  let admin: Pool, pool: Pool, directory: string, host: ReturnType<typeof createExecutorHost>, client: ExecutorClient, url: string;
  const database = `agents_executor_${randomUUID().replaceAll("-", "")}`, key = randomBytes(32).toString("hex"), calls: { command: string; recovering: boolean }[] = [];
  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.AGENTS_TEST_DATABASE_URL }); await admin.query(`CREATE DATABASE "${database}"`);
    const connection = new URL(process.env.AGENTS_TEST_DATABASE_URL!); connection.pathname = `/${database}`; pool = new Pool({ connectionString: connection.href }); await setupPlatformSchema(pool); directory = await mkdtemp(join(tmpdir(), "agents-executor-protocol-"));
    host = createExecutorHost({ pool, executorId: "original", key, journalDirectory: directory, async dispatch(request, recovering) {
      calls.push({ command: request.command, recovering }); return { allocationId: request.allocationId, state: request.command === "destroy" || request.command === "quiesce" ? "destroyed" : "completed", invocation: calls.length };
    } });
    url = await host.listen({ port: 0, host: "127.0.0.1" }); client = new ExecutorClient(pool, [{ id: "original", url, key }, { id: "replacement", url, key }], "original");
  });
  afterAll(async () => { await host?.close(); await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } if (directory) await rm(directory, { recursive: true, force: true }); });
  const claim = () => client.claim("sandbox", randomUUID(), { fixture: randomUUID() }, new Date(Date.now() + 60_000));
  it("authenticates complete allocation/generation/body identity and denies tampering before dispatch", async () => {
    const owner = await claim(), body: ExecutorRequest = { schemaVersion: "1", resourceKind: "sandbox", allocationId: owner.allocation_id, executorId: owner.executor_id, generation: owner.generation, commandId: randomUUID(), command: "destroy", issuedAt: Date.now(), payload: null };
    const before = calls.length, signature = executorSignature(body, key); body.command = "start";
    const response = await fetch(url + "/v1/resources/commands", { method: "POST", headers: { "content-type": "application/json", "x-executor-signature": signature }, body: JSON.stringify(body) });
    expect(response.status).toBe(403); expect(calls).toHaveLength(before);
  });
  it("recovers a completed command after an acknowledged result is discarded, without executing again", async () => {
    const owner = await claim(), commandId = randomUUID(), first = await client.call(owner, "destroy", { fixed: "input" }, commandId), count = calls.length;
    const replay = await client.call(owner, "destroy", { fixed: "input" }, commandId); expect(replay).toEqual(first); expect(calls).toHaveLength(count);
    await expect(client.call(owner, "destroy", { fixed: "changed" }, commandId)).rejects.toMatchObject({ code: "EXECUTOR_COMMAND_CONFLICT" });
  });
  it("does not turn an expired lease into replacement authority or overlapping start", async () => {
    const owner = await claim(); await pool.query("UPDATE agents_platform.resource_executor_owners SET lease_expires_at=now()-interval '1 second' WHERE allocation_id=$1", [owner.allocation_id]);
    const count = calls.length; await expect(client.call(owner, "analyze", {})).rejects.toMatchObject({ code: "EXECUTOR_LEASE_EXPIRED" }); expect(calls).toHaveLength(count);
    await expect(client.owners.transfer(owner, "replacement", "0".repeat(64))).rejects.toMatchObject({ code: "EXECUTOR_TRANSFER_DENIED" });
    expect((await client.call(owner, "status", null)).state).toBe("completed");
  });
  it("requires executor-confirmed quiescence before transfer and rejects stale physical handlers afterward", async () => {
    const owner = await claim(), moved = await client.transfer("sandbox", owner.allocation_id, "replacement"); expect(moved.generation).toBe("2"); expect(moved.quiescent).toBe(true);
    const count = calls.length;
    for (const command of ["start", "status", "destroy"] as const) await expect(client.call(owner, command, null)).rejects.toMatchObject({ code: "EXECUTOR_GENERATION_STALE" });
    expect(calls).toHaveLength(count);
  });
  it("preserves the original owner despite a different client's default route", async () => {
    const owner = await claim(), second = new ExecutorClient(pool, client.routes, "replacement"); expect((await second.owner("sandbox", owner.allocation_id)).executor_id).toBe("original");
    expect((await second.call(await second.owner("sandbox", owner.allocation_id), "status", null)).allocationId).toBe(owner.allocation_id);
    await expect(second.owner("sandbox", randomUUID())).rejects.toMatchObject({ code: "EXECUTOR_OWNER_UNKNOWN" });
  });
  it("retains uncertain physical capacity after lease expiry until confirmed cleanup", async () => {
    const first = await claim(), second = await claim(), third = await claim();
    await client.call(first, "start", null); await client.call(second, "start", null);
    await pool.query("UPDATE agents_platform.resource_executor_owners SET lease_expires_at=now()-interval '1 second' WHERE allocation_id=$1", [first.allocation_id]);
    const count = calls.length;
    await expect(client.call(third, "start", null)).rejects.toMatchObject({ code: "EXECUTOR_CAPACITY_BUSY" }); expect(calls).toHaveLength(count);
    await client.call(first, "destroy", null);
    expect((await client.call(third, "start", null)).state).toBe("completed");
    await client.call(second, "destroy", null); await client.call(third, "destroy", null);
  });
  it("rejects rebinding the same executor ID to a new physical directory", async () => {
    const otherDirectory = await mkdtemp(join(tmpdir(), "agents-executor-replacement-"));
    const replacement = createExecutorHost({ pool, executorId: "original", key, journalDirectory: otherDirectory, async dispatch() { throw new Error("must not dispatch"); } });
    try { await expect(replacement.ready()).rejects.toThrow("another physical directory"); }
    finally { await replacement.close(); await rm(otherDirectory, { recursive: true, force: true }); }
  });

  it("waits for an in-flight physical document launch before proving quiescence and transferring", async () => {
    const raceDirectory = await mkdtemp(join(tmpdir(), "agents-executor-race-"));
    let started!: () => void, finish!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; }), release = new Promise<void>(resolve => { finish = resolve; });
    const dispatched: string[] = [];
    const raceHost = createExecutorHost({ pool, executorId: "race", key, journalDirectory: raceDirectory, async dispatch(request) {
      dispatched.push(request.command);
      if (request.command === "start") { started(); await release; return { state: "running" }; }
      return { state: "destroyed" };
    } });
    try {
      const raceUrl = await raceHost.listen({ host: "127.0.0.1", port: 0 });
      const raceClient = new ExecutorClient(pool, [{ id: "race", url: raceUrl, key }, { id: "replacement", url, key }], "race");
      const owner = await raceClient.claim("document", randomUUID(), { fixture: "race" }, new Date(Date.now() + 60_000));
      const launch = raceClient.call(owner, "start", null); await entered;
      const transfer = raceClient.transfer("document", owner.allocation_id, "replacement");
      await new Promise(resolve => setTimeout(resolve, 30)); expect(dispatched).toEqual(["start"]);
      finish(); await expect(launch).resolves.toMatchObject({ state: "running" });
      expect((await transfer).generation).toBe("2"); expect(dispatched).toEqual(["start", "quiesce"]);
      await expect(raceClient.call(owner, "start", null)).rejects.toMatchObject({ code: "EXECUTOR_GENERATION_STALE" });
      expect(dispatched).toEqual(["start", "quiesce"]);
    } finally { finish?.(); await raceHost.close(); await rm(raceDirectory, { recursive: true, force: true }); }
  });

});
