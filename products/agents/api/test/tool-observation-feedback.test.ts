import { expect, it } from "vitest";
import { builtinObservationView } from "../src/capabilities/tool-observation-feedback";
import { orchestrationContracts } from "../src/contracts/orchestration";
import { builtinContract } from "../src/capabilities/tool-contracts";

it("explains an empty literal discovery filter without altering its durable result or echoing private input", () => {
  const receipt = Object.freeze({ specialists: Object.freeze([]), nextOffset: null });
  const observation = builtinObservationView("agents.discover", JSON.stringify({ query: "PRIVATE_business_question" }), receipt) as any;
  expect(observation.specialists).toEqual([]);
  expect(observation.discoveryNotice).toMatchObject({ code: "LITERAL_FILTER_NO_MATCH", retryInput: {} });
  expect(observation.discoveryNotice.message).toContain("Call agents.discover with {}");
  expect(JSON.stringify(observation)).not.toContain("PRIVATE_");
  expect(Buffer.byteLength(JSON.stringify(observation))).toBeLessThan(700);
  expect(receipt).toEqual({ specialists: [], nextOffset: null });
  expect(orchestrationContracts["agents.discover"].output.safeParse(receipt).success).toBe(true);
});

it("preserves unfiltered discovery, successful matches, malformed requests and other tool observations", () => {
  const empty = { specialists: [], nextOffset: null };
  for (const raw of ["{}", '{"query":"   "}', '{"bindingId":"missing"}', '{"query":123}', '{"query":"PRIVATE_', '{"query":"private","extra":true}']) {
    expect(builtinObservationView("agents.discover", raw, empty)).toBe(empty);
  }
  const matched = { specialists: [{ bindingId: "writer", name: "Writer", description: "Draft", versionId: "8c703822-16b1-45bf-a93a-2ad6d3b3d1b1", ready: true, reasons: [], tools: [], sourceCount: 0 }], nextOffset: null };
  expect(builtinObservationView("agents.discover", '{"query":"draft"}', matched)).toBe(matched);
  expect(builtinObservationView("agents.status", '{"query":"private"}', empty)).toBe(empty);
  expect(builtinObservationView("agents.discover", '{"query":"private"}', { error: "DENIED" })).toEqual({ error: "DENIED" });
});

it("labels legacy specialist reports and permitted scope in the model-only view", () => {
  const receipt = {
    children: [{ taskId: "8c703822-16b1-45bf-a93a-2ad6d3b3d1b1", bindingId: "research", state: "completed",
      output: "The report claims the launch offer is active.", outputTruncated: false, originalBytes: 43, errorCode: null,
      sourceRevisionIds: ["d59ff6b5-5c59-4e8e-897d-78304b64aeca"], connectedToolBindingIds: [], usage: { tokens: 100, modelCalls: 1, toolCalls: 0 } }],
    partial: false,
  };
  const observation = builtinObservationView("agents.delegate", "{}", receipt) as any;
  expect(observation.interpretation).toContain("agent-reported");
  expect(observation.children[0].reportAssessment).toEqual({ origin: "agent_reported", correctness: "not_assessed", coverage: "not_assessed" });
  expect(observation.children[0].authorizedScope).toMatchObject({ sourceRevisionIds: receipt.children[0]!.sourceRevisionIds,
    connectedToolBindingIds: [], meaning: expect.stringContaining("Permitted scope only") });
  expect(observation.children[0].output).toBe(receipt.children[0]!.output);
  expect(Object.keys(observation.children[0]).indexOf("reportAssessment")).toBeLessThan(Object.keys(observation.children[0]).indexOf("output"));
  expect(receipt.children[0]).toHaveProperty("sourceRevisionIds");
  expect(builtinContract("agents.delegate")!.output.safeParse(receipt).success).toBe(true);
  expect(builtinContract("agents.delegate")!.output.safeParse(observation).success).toBe(false);
});
