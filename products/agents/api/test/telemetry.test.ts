import { emitModelInvocation } from "../src/observability/model-telemetry";
import {emitConnectionControlEvent} from "../src/observability/connection-telemetry";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { expect, it,vi } from "vitest";
import { requestDigest } from "../src/contracts/contracts";
import { makeObservation } from "../src/observability/observations";
import { createObservationTelemetry } from "../src/observability/telemetry";

it("exports specialist work beneath its own task while preserving root lineage", async () => {
  const received: any[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "content-type": "application/json" }); response.end("{}");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const root = randomUUID(), child = randomUUID(), operationId = `model:${child}:0`;
  const identity = { product: "agents" as const, organizationId: randomUUID(), agentId: randomUUID(), versionId: randomUUID(),
    programId: "tool-directed", programVersion: "1", runtimeRelease: "fixture", conversationId: randomUUID(),
    rootTaskId: root, parentTaskId: null, taskId: root, operationId: null, attemptId: null };
  const event = (taskId: string, parentTaskId: string | null, eventKey: string, kind: string) => makeObservation({
    identity: { ...identity, taskId, parentTaskId, ...(eventKey === "accepted" ? {} : { operationId, attemptId: randomUUID() }) },
    eventKey, kind, occurredAt: new Date().toISOString(),
  });
  const events = [event(root, null, "accepted", "accepted"), event(child, root, "accepted", "accepted"),
    event(child, root, "model:0:completed", "model.completed")];
  const telemetry = createObservationTelemetry("parentage-test", { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/traces` })!;
  try {
    await telemetry.export(events);
    const spans = received.flatMap(body => body.resourceSpans.flatMap((resource: any) => resource.scopeSpans.flatMap((scope: any) => scope.spans)));
    expect(spans).toHaveLength(3);
    const rootSpan = spans.find(span => span.spanId === events[0]!.id.slice(0, 16));
    const childSpan = spans.find(span => span.spanId === events[1]!.id.slice(0, 16));
    const modelSpan = spans.find(span => span.spanId === events[2]!.id.slice(0, 16));
    expect(rootSpan.parentSpanId ?? "").toBe("");
    expect(childSpan.parentSpanId).toBe(rootSpan.spanId);
    expect(modelSpan.parentSpanId).toBe(childSpan.spanId);
    expect(new Set(spans.map(span => span.traceId))).toEqual(new Set([requestDigest(root).slice(0, 32)]));
    const log=vi.spyOn(console,"info").mockImplementation(()=>{}),controlTrace=requestDigest("control-plane-fixture").slice(0,32);
    try{
      emitConnectionControlEvent({event:"connection.lifecycle",traceId:controlTrace,provider:"mcp",flow:"refresh",outcome:"failed",failureClass:"authorization",durationMs:23,authorizationGeneration:4,connectionId:randomUUID()});
      for(let n=0;n<100&&received.length<2;n++)await new Promise(resolve=>setTimeout(resolve,10));
      expect(received).toHaveLength(2);
      const controls=received[1].resourceSpans.flatMap((resource:any)=>resource.scopeSpans.flatMap((scope:any)=>scope.spans));
      expect(controls).toHaveLength(1);expect(controls[0].name).toBe("connection.refresh");expect(controls[0].traceId).toBe(controlTrace);
      const attrs=Object.fromEntries(controls[0].attributes.map((attribute:any)=>[attribute.key,attribute.value.stringValue??Number(attribute.value.intValue)]));
      expect(attrs).toMatchObject({"agents.authorizationGeneration":4,"agents.durationMs":23,"agents.failureClass":"authorization"});
      expect(controls[0].parentSpanId??"").toBe("");expect(JSON.stringify(controls)).not.toMatch(/taskId|agentId|versionId|authorizationUrl|scope/);
      emitModelInvocation({event:"model.invocation",traceId:requestDigest(root).slice(0,32),organizationId:identity.organizationId,
        rootTaskId:root,taskId:child,operationId,connectionId:randomUUID(),providerId:"openai",protocol:"openai_responses",modelId:"fixture-model",
        role:"delegated",routeDigest:"a".repeat(64),policyDigest:"b".repeat(64),adapterRevision:"fixture-1",runtimeRelease:"fixture-release",
        outcome:"completed",durationMs:12,firstVisibleTokenStatus:"observed",firstVisibleTokenMs:3,queueStatus:"unavailable",
        usageStatus:"observed",inputTokens:10,outputTokens:3,costStatus:"unavailable"});
      for(let n=0;n<100&&received.length<3;n++)await new Promise(resolve=>setTimeout(resolve,10));
      expect(received).toHaveLength(3);
      const invocations=received[2].resourceSpans.flatMap((resource:any)=>resource.scopeSpans.flatMap((scope:any)=>scope.spans));
      expect(invocations).toHaveLength(1);expect(invocations[0].name).toBe("model.invocation");
      expect(invocations[0].parentSpanId).toBe(childSpan.spanId);expect(invocations[0].traceId).toBe(rootSpan.traceId);
      expect(JSON.stringify(invocations)).toContain("agents.firstVisibleTokenMs");
      expect(JSON.stringify(invocations)).not.toMatch(/Bearer|apiKey|privateNative|messages|prompt|endpoint/);

    }finally{log.mockRestore();}

  } finally {
    await telemetry.shutdown(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
