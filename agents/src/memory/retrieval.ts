import { memoryPolicyFromAgentPolicy, type MemoryPolicy } from "./policy";

export type RetrievalReason = "always" | "direct_reference" | "preference_reference" | "contextual_question" | "policy_disabled" | "not_requested";

export interface RetrievalDecision {
  requested: boolean;
  reason: RetrievalReason;
  query: string;
}

const directReference = /\b(remember|previous|earlier|last time|history|context|you said|we discussed|as i mentioned|before)\b/i;
const preferenceReference = /\b(my|our|the)\s+(preference|preferences|usual|defaults?|settings?)\b|\bwhat do you know about me\b/i;
const contextualQuestion = /\b(what did we|where were we|continue|pick up|remind me|have i told you|did i mention)\b/i;

export function decideMemoryRetrieval(
  message: string,
  options: { always?: boolean; policy?: MemoryPolicy | unknown } = {},
): RetrievalDecision {
  const policy = options.policy && typeof options.policy === "object" && "mode" in options.policy
    ? options.policy as MemoryPolicy
    : memoryPolicyFromAgentPolicy(options.policy);
  const query = message.trim().slice(0, 4_000);
  if (policy.mode === "disabled") return { requested: false, reason: "policy_disabled", query };
  if (options.always) return { requested: true, reason: "always", query };
  if (directReference.test(query)) return { requested: true, reason: "direct_reference", query };
  if (preferenceReference.test(query)) return { requested: true, reason: "preference_reference", query };
  if (contextualQuestion.test(query)) return { requested: true, reason: "contextual_question", query };
  return { requested: false, reason: "not_requested", query };
}

export function retrievalGate(message: string, options: { always?: boolean } = {}): boolean {
  return decideMemoryRetrieval(message, options).requested;
}
