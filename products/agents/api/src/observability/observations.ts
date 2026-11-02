import { requestDigest } from "../contracts/contracts";
import { observationMetadataSchema, observationSchema, type AgentObservation, type ObservationIdentity } from "../contracts/observations";

export function observationCategory(kind: string): AgentObservation["category"] {
  const prefix = kind.split(".", 1)[0];
  if (["model", "tool", "context", "memory", "review", "channel", "resource", "authority"].includes(prefix!)) return prefix as AgentObservation["category"];
  if (prefix === "children" || prefix === "delegation") return "delegation";
  if (prefix === "action" || prefix === "workflow") return "workflow";
  return "task";
}

/** Project explicit scalar fields. Prompt text, arguments, results and credentials cannot enter telemetry. */
export function makeObservation(input: {
  identity: ObservationIdentity; eventKey: string; kind: string; occurredAt: string; metadata?: unknown;
}): AgentObservation {
  const candidate = input.metadata && typeof input.metadata === "object" ? input.metadata as Record<string, unknown> : {};
  const metadata: Record<string, unknown> = {};
  for (const [key, validator] of Object.entries(observationMetadataSchema.shape)) {
    const parsed = validator.safeParse(candidate[key]);
    if (parsed.success && parsed.data !== undefined) metadata[key] = parsed.data;
  }
  return observationSchema.parse({
    schemaVersion: "agent.observation.v1", id: requestDigest([input.identity.taskId, input.eventKey]),
    eventKey: input.eventKey, kind: input.kind, category: observationCategory(input.kind),
    occurredAt: input.occurredAt, identity: input.identity, metadata,
  });
}
