import { describe, expect, it } from "vitest";
import { buildGroundingProvenance } from "../src/runtime/provenance";

describe("grounding provenance", () => {
  it("records safe evidence summaries and keeps organization scope explicit", () => {
    expect(buildGroundingProvenance({
      authorizedTools: ["kasitek.core.content_posts_list", "platform.current_time", "platform.current_time"],
      usedTools: ["kasitek.core.content_posts_list"],
      retrievalRequested: true,
      knowledgeMatchCount: 2.9,
    })).toEqual({
      schema: "kasiai-grounding-v1",
      organizationScoped: true,
      reviewedKnowledge: { requested: true, matchedChunks: 2 },
      toolEvidence: {
        authorized: ["kasitek.core.content_posts_list", "platform.current_time"],
        used: ["kasitek.core.content_posts_list"],
      },
      unavailableActions: [],
      uncertainty: "not_asserted",
      untrustedInputs: ["current-user-message", "conversation-history", "client-ui-context", "tool-output"],
      completionClaimRequiresTrustedEvidence: true,
    });
  });

  it("does not expose prompt, tool arguments, or provider output", () => {
    const provenance = buildGroundingProvenance({ authorizedTools: ["platform.current_time"], usedTools: [], unavailableTools: ["kasitek.core.content_post_publish"], retrievalRequested: false, knowledgeMatchCount: 0 });
    expect(provenance.unavailableActions).toEqual(["kasitek.core.content_post_publish"]);
    expect(JSON.stringify(provenance)).not.toContain("prompt");
    expect(JSON.stringify(provenance)).not.toContain("arguments");
    expect(JSON.stringify(provenance)).not.toContain("provider");
  });
});
