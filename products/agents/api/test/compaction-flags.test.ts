import { afterEach, describe, expect, it } from "vitest";
import { compactionFlags } from "../src/execution/context/compaction-flags";
import { compactConversation } from "../src/execution/context/manual-compaction";

const previous = { ...process.env };
afterEach(() => {
  for (const key of ["AGENTS_COMPACTION_POLICY", "AGENTS_COMPACTION_BACKGROUND", "AGENTS_COMPACTION_MANUAL"]) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  }
});

describe("compaction rollout flags", () => {
  it("defaults to pressure compaction with background and manual enabled", () => {
    expect(compactionFlags({})).toEqual({ policy: "pressure", background: true, manual: true });
  });

  it("reads off and boolean overrides", () => {
    expect(compactionFlags({ AGENTS_COMPACTION_POLICY: "off", AGENTS_COMPACTION_BACKGROUND: "false", AGENTS_COMPACTION_MANUAL: "0" }))
      .toEqual({ policy: "off", background: false, manual: false });
    expect(compactionFlags({ AGENTS_COMPACTION_BACKGROUND: "yes", AGENTS_COMPACTION_MANUAL: "on" }))
      .toEqual({ policy: "pressure", background: true, manual: true });
  });

  it("rejects unknown values instead of silently changing rollout behavior", () => {
    expect(() => compactionFlags({ AGENTS_COMPACTION_POLICY: "later" })).toThrow("AGENTS_COMPACTION_POLICY");
    expect(() => compactionFlags({ AGENTS_COMPACTION_BACKGROUND: "maybe" })).toThrow("AGENTS_COMPACTION_BACKGROUND");
    expect(() => compactionFlags({ AGENTS_COMPACTION_MANUAL: "sometimes" })).toThrow("AGENTS_COMPACTION_MANUAL");
  });

  it("does not admit a manual maintenance task when the manual flag is off", async () => {
    process.env.AGENTS_COMPACTION_MANUAL = "false";
    await expect(compactConversation({} as never, {
      accountId: "account", organizationId: "organization", agentId: "agent", conversationId: "conversation",
    })).rejects.toMatchObject({ code: "COMPACTION_DISABLED" });
  });
});
