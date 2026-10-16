import { describe, expect, it } from "vitest";
import { agentSlugCandidate } from "../src/db/repositories/agent-repository";

describe("agentSlugCandidate", () => {
  it("keeps the base slug for the first candidate", () => {
    expect(agentSlugCandidate("support-agent", 1)).toBe("support-agent");
  });

  it("adds a deterministic suffix for collisions", () => {
    expect(agentSlugCandidate("support-agent", 2)).toBe("support-agent-2");
    expect(agentSlugCandidate("support-agent", 3)).toBe("support-agent-3");
  });

  it("keeps suffixed candidates within the API limit", () => {
    const base = "a".repeat(80);
    expect(agentSlugCandidate(base, 2)).toHaveLength(80);
    expect(agentSlugCandidate(base, 2).endsWith("-2")).toBe(true);
  });
});
