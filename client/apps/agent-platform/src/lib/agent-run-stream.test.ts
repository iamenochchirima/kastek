import assert from "node:assert/strict";
import { AgentRequestError, streamAgentRun } from "./agent-platform";

const originalFetch = globalThis.fetch;
try {
  for (const status of ["completed", "failed", "cancelled", "expired", "running"]) {
    const paths: string[] = [];
    globalThis.fetch = async (input, init) => {
      paths.push(String(input));
      assert.equal(init?.credentials, "include");
      return paths.length === 1
        ? new Response(": keep-alive\n\n", { headers: { "Content-Type": "text/event-stream" } })
        : Response.json({ run: { status } });
    };
    const events: unknown[] = [];
    const result = await streamAgentRun("run-1", event => events.push(event), new AbortController().signal, 7);
    assert.deepEqual(paths, ["/api/agents/runs/run-1/events/stream?after=7", "/api/agents/runs/run-1"]);
    assert.deepEqual(result, { lastSequence: 7, terminal: status !== "running" });
    assert.deepEqual(events, []); // No terminal event is invented from a status read.
  }

  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response('event: run.completed\ndata: {"sequence_number":8}\n\n');
  };
  assert.deepEqual(await streamAgentRun("run-1", () => {}, new AbortController().signal, 7), { lastSequence: 8, terminal: true });
  assert.equal(calls, 1);

  calls = 0;
  globalThis.fetch = async () => ++calls === 1
    ? new Response(": keep-alive\n\n")
    : Response.json({ error: "run_not_found" }, { status: 404 });
  await assert.rejects(streamAgentRun("run-1", () => {}, new AbortController().signal, 7),
    cause => cause instanceof AgentRequestError && cause.status === 404);
} finally {
  globalThis.fetch = originalFetch;
}
console.log("agent run stream completion recovery: ok");
