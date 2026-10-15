import { describe, expect, it } from "vitest";
import { remoteMcpToolSchema } from "../src/mcp/remote";
import { projectReviewedMcpResult, remoteMcpPublicationSchema } from "../src/mcp/reviewed-result";
import { redactToolOutput } from "../src/tools/redaction";

describe("reviewed remote result boundary", () => {
  it("returns only approved scalar fields while preserving raw audit redaction", () => {
    const remote = { content: [{ type: "text", text: JSON.stringify({ reference: "BOOK-739", status: "confirmed", apiKey: "hidden", customer: { email: "private" }, extra: "not reviewed" }) }] };
    const reviewedResult = projectReviewedMcpResult(remote, ["reference", "status", "apiKey", "customer"]);
    expect(redactToolOutput({ result: remote, reviewedResult }, ["result"]))
      .toEqual({ result: "[REDACTED]", reviewedResult: { reference: "BOOK-739", status: "confirmed" } });
    expect(projectReviewedMcpResult(remote, [])).toEqual({});
  });
  it("does not accept server-supplied review or credential fields", () => {
    expect(remoteMcpToolSchema.parse({ name: "lookup", reviewedResultFields: ["status"] })).not.toHaveProperty("reviewedResultFields");
    expect(() => remoteMcpPublicationSchema.parse({ resultFields: { lookup: ["accessToken"] } })).toThrow();
  });
  it("bounds structured output and treats MCP error results as failures", () => {
    expect(projectReviewedMcpResult({ structuredContent: { status: "x".repeat(3000), nested: { arbitrary: true } } }, ["status", "nested"]))
      .toEqual({ status: "x".repeat(2000) });
    expect(() => projectReviewedMcpResult({ isError: true, content: [{ type: "text", text: "denied" }] }, [])).toThrow("REMOTE_MCP_TOOL_FAILED");
  });
});
