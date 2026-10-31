import { expect, it } from "vitest";
import { builtinObservationView } from "../src/capabilities/tool-observation-feedback";
import { orchestrationContracts } from "../src/contracts/orchestration";

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
