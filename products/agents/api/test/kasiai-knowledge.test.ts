import { describe, expect, it } from "vitest";
import {
  KASIAI_KNOWLEDGE_CHUNKS,
  KASIAI_KNOWLEDGE_SOURCE_NAME,
  KASIAI_KNOWLEDGE_VERSION,
} from "../src/system/kasiai-knowledge";

describe("KasiAi reviewed knowledge", () => {
  it("describes the scoped content policy without reverting to a read-only claim", () => {
    const limitations = KASIAI_KNOWLEDGE_CHUNKS.find((chunk) => chunk.startsWith("Safe limitations:"));

    expect(limitations).toBeDefined();
    expect(limitations).toContain("reviewable content drafts");
    expect(limitations).toContain("explicit user approval");
    expect(limitations).toContain("trusted tool result confirms it");
    expect(limitations).not.toContain("read-only for product actions");
    expect(limitations).toContain("cannot send campaigns");
  });

  it("pins the reviewed corpus version in its source name", () => {
    expect(KASIAI_KNOWLEDGE_VERSION).toBeGreaterThan(1);
    expect(KASIAI_KNOWLEDGE_SOURCE_NAME).toBe(`KasiTek platform guidance v${KASIAI_KNOWLEDGE_VERSION}`);
  });
});
