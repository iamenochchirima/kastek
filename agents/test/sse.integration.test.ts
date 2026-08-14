import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app";
import type { AppConfig } from "../src/config";

const config: AppConfig = {
  NODE_ENV: "test",
  PORT: 0,
  HOST: "127.0.0.1",
  AGENTS_DATABASE_URL: "postgres://unused",
  AGENTS_DATABASE_POOL_MAX: 1,
  TEMPORAL_ENABLED: false,
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "test",
  INTERNAL_AUTH_AUDIENCE: "test",
  AUTH_MODE: "headers",
  LOG_LEVEL: "silent",
};

const fakePool = { query: async () => ({ rows: [{ ok: 1 }] }) } as never;

describe("live run-event SSE recovery", () => {
  let app: ReturnType<typeof buildApp> | undefined;

  afterEach(async () => {
    if (app) {
      app.server.closeAllConnections();
      await app.close();
    }
    app = undefined;
  });

  it("resumes after a disconnect without replaying events before the cursor", async () => {
    const events = [
      { sequence_number: "1", event_type: "run.started", payload: { status: "running" }, created_at: "2026-08-14T00:00:00.000Z" },
      { sequence_number: "2", event_type: "run.completed", payload: { status: "completed" }, created_at: "2026-08-14T00:00:01.000Z" },
    ];
    const cursors: number[] = [];
    let runStatus = "running";
    const runs = {
      getRun: async (_organizationId: string, runId: string) => runId === "run-sse-1"
        ? { id: runId, organization_id: "org-sse", status: runStatus }
        : null,
      listEventsAfter: async (_organizationId: string, runId: string, after: number) => {
        expect(runId).toBe("run-sse-1");
        cursors.push(after);
        return events.filter((event) => Number(event.sequence_number) > after);
      },
    } as never;

    app = buildApp({ config, pool: fakePool, runs });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("SSE test server did not bind");
    const url = `http://127.0.0.1:${address.port}/v1/runs/run-sse-1/events/stream`;

    const firstController = new AbortController();
    const first = await fetch(url, { signal: firstController.signal, headers: { "x-organization-id": "org-sse", "x-actor-id": "user-sse" } });
    expect(first.status).toBe(200);
    const firstReader = first.body?.getReader();
    if (!firstReader) throw new Error("SSE response did not expose a body");
    const firstChunk = await firstReader.read();
    const firstText = new TextDecoder().decode(firstChunk.value);
    expect(firstText).toContain("id: 1");
    expect(firstText).toContain("id: 2");
    firstController.abort();

    const resumedController = new AbortController();
    const resumed = await fetch(`${url}?after=1`, { signal: resumedController.signal, headers: { "x-organization-id": "org-sse", "x-actor-id": "user-sse" } });
    expect(resumed.status).toBe(200);
    const resumedReader = resumed.body?.getReader();
    if (!resumedReader) throw new Error("resumed SSE response did not expose a body");
    const resumedChunk = await resumedReader.read();
    const resumedText = new TextDecoder().decode(resumedChunk.value);
    expect(resumedText).toContain("id: 2");
    expect(resumedText).not.toContain("id: 1");
    resumedController.abort();

    runStatus = "completed";
    const terminal = await fetch(`${url}?after=2`, { headers: { "x-organization-id": "org-sse", "x-actor-id": "user-sse" } });
    expect(terminal.status).toBe(200);
    await expect(terminal.text()).resolves.toContain(": keep-alive");
    expect(cursors).toEqual([0, 1, 2]);
  });
});
