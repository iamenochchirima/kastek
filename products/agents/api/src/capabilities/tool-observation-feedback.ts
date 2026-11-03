import { orchestrationContracts } from "../contracts/orchestration";
import { legacyDelegationResultSchema } from "./tool-contracts";

/** Model-only guidance; the recorded operation outcome and published tool contract stay unchanged. */
export function builtinObservationView(name: string, rawArguments: string, value: unknown): unknown {
  if (name === "agents.delegate") {
    const output = legacyDelegationResultSchema.safeParse(value);
    if (!output.success) return value;
    return {
      interpretation: "Each child report is agent-reported; factual correctness and coverage are not assessed. Authorized source and connection IDs describe permitted scope, not sources actually used or actions performed. This result contains no native receipts confirming claimed actions.",
      children: output.data.children.map(child => ({
        reportAssessment: { origin: "agent_reported", correctness: "not_assessed", coverage: "not_assessed" },
        taskId: child.taskId,
        bindingId: child.bindingId,
        state: child.state,
        output: child.output,
        outputTruncated: child.outputTruncated,
        originalBytes: child.originalBytes,
        errorCode: child.errorCode,
        authorizedScope: {
          sourceRevisionIds: child.sourceRevisionIds,
          connectedToolBindingIds: child.connectedToolBindingIds,
          meaning: "Permitted scope only; these IDs do not show which sources were used or actions performed.",
        },
        usage: child.usage,
      })),
      partial: output.data.partial,
    };
  }
  if (name !== "agents.discover") return value;
  let input: unknown;
  try { input = JSON.parse(rawArguments); } catch { return value; }
  const args = orchestrationContracts["agents.discover"].input.safeParse(input);
  const output = orchestrationContracts["agents.discover"].output.safeParse(value);
  if (!args.success || !output.success || !args.data.query?.trim() || output.data.specialists.length) return value;
  return {
    ...output.data,
    discoveryNotice: {
      code: "LITERAL_FILTER_NO_MATCH",
      message: "The query is a literal filter over the permitted roster's identifiers, names and descriptions. No matches does not mean no specialists are available. Call agents.discover with {} to list the permitted roster, then choose from the returned bindings.",
      retryInput: {},
    },
  };
}
