/**
 * Safe, machine-readable grounding evidence attached to a completed run.
 * This is a summary rather than a transcript or model explanation.
 */
export interface GroundingProvenance {
  schema: "kasiai-grounding-v1";
  organizationScoped: true;
  reviewedKnowledge: { requested: boolean; matchedChunks: number };
  toolEvidence: { authorized: string[]; used: string[] };
  unavailableActions: string[];
  uncertainty: "not_asserted";
  untrustedInputs: string[];
  completionClaimRequiresTrustedEvidence: true;
}

export function buildGroundingProvenance(input: {
  authorizedTools: Iterable<string>;
  usedTools: Iterable<string>;
  unavailableTools?: Iterable<string>;
  retrievalRequested: boolean;
  knowledgeMatchCount: number;
}): GroundingProvenance {
  return {
    schema: "kasiai-grounding-v1",
    organizationScoped: true,
    reviewedKnowledge: {
      requested: input.retrievalRequested,
      matchedChunks: Math.max(0, Math.floor(input.knowledgeMatchCount)),
    },
    toolEvidence: {
      authorized: [...new Set(input.authorizedTools)].sort(),
      used: [...new Set(input.usedTools)].sort(),
    },
    unavailableActions: [...new Set(input.unavailableTools ?? [])].sort(),
    uncertainty: "not_asserted",
    untrustedInputs: ["current-user-message", "conversation-history", "client-ui-context", "tool-output"],
    completionClaimRequiresTrustedEvidence: true,
  };
}
