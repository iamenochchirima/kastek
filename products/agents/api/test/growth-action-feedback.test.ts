import { describe, it, expect } from "vitest";
import { generateKeyPair, exportPKCS8 } from "jose";
import { randomUUID } from "node:crypto";
import type { ProductCapabilityInvocation } from "@kasitek-labs/contracts";
import { GrowthActionClient } from "../src/adapters/products/growth-action-client";

describe("Growth model argument feedback", () => {
  it("normalizes destination draft validation into recoverable model feedback without masking authority failures", async () => {
    const keys = await generateKeyPair("RS256", { extractable: true });
    const options = { origin: "https://growth.example.test", issuer: "https://agents.example.test", keyId: "worker", privateKey: await exportPKCS8(keys.privateKey) };
    const invocation = { version: "1", requestId: randomUUID(), operationId: "tool:prepare", taskId: randomUUID(), conversationId: randomUUID() } as ProductCapabilityInvocation;
    for (const [status, code, expected] of [[400, "agent_tool_arguments_invalid", "TOOL_ARGUMENTS_INVALID"], [422, "agent_tool_arguments_invalid", "TOOL_ARGUMENTS_INVALID"], [403, "agent_capability_denied", "AGENT_CAPABILITY_DENIED"], [500, "internal_error", "INTERNAL_ERROR"]] as const) {
      const client = new GrowthActionClient({ ...options, fetch: async () => new Response(JSON.stringify({ code, error: "Unavailable" }), { status }) });
      await expect(client.invoke(invocation)).rejects.toMatchObject({ code: expected, statusCode: status >= 500 ? 503 : status });
    }
  });
});
