import type { KnowledgeChunkRecord, KnowledgeRepository } from "../db/repositories/knowledge-repository";
import type { MemoryNamespace, MemoryRecord, MemoryScope } from "../db/repositories/memory-repository";
import { MemoryLifecycle } from "./lifecycle";
import { memoryPolicyFromAgentPolicy, type MemoryPolicy } from "./policy";
import { recordRetrievalDuration } from "../telemetry/spans";

export type RetrievalSourceType = "memory" | "knowledge";
export type RetrievalReason = "always" | "direct_reference" | "preference_reference" | "contextual_question" | "semantic_reference" | "knowledge_reference" | "policy_disabled" | "not_requested";

export interface RetrievalDecision {
  requested: boolean;
  reason: RetrievalReason;
  /** Stable bounded reason code for metrics and run evidence. */
  reasonCode: RetrievalReason;
  query: string;
  sourceTypes: RetrievalSourceType[];
  maxResults: number;
  maxTokens: number;
}

export interface RetrievalEvidence {
  sourceType: RetrievalSourceType;
  id: string;
  text: string;
  score: number;
  rank: number;
  namespace?: MemoryNamespace;
  sourceId?: string;
  chunkIndex?: number;
  provenance: Record<string, unknown>;
}

export interface RetrievalResult {
  decision: RetrievalDecision;
  evidence: RetrievalEvidence[];
  memoryMatches: MemoryRecord[];
  knowledgeMatches: KnowledgeChunkRecord[];
}

const directReferenceTerms = new Set([
  "remember", "recall", "previous", "earlier", "prior", "history", "context", "mentioned", "discussed", "before", "last",
]);
const preferenceTerms = new Set(["preference", "preferences", "usual", "default", "defaults", "settings", "style"]);
const semanticReferenceTerms = new Set(["agreed", "decided", "settled", "saved", "chosen", "configured", "stored", "prefer", "prefers"]);
const knowledgeReferenceTerms = new Set(["documentation", "docs", "faq", "guide", "policy", "policies", "specification", "spec", "pricing", "supported", "available"]);

function normalizeTokens(value: string): string[] {
  return value
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 800);
}

function includesPhrase(tokens: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length > tokens.length) return false;
  for (let index = 0; index <= tokens.length - phrase.length; index += 1) {
    if (phrase.every((token, offset) => tokens[index + offset] === token)) return true;
  }
  return false;
}

function sourceTypesFor(policy: MemoryPolicy): RetrievalSourceType[] {
  return policy.mode !== "disabled" && policy.maxRetrieved > 0 && policy.readableNamespaces.length > 0
    ? ["memory", "knowledge"]
    : ["knowledge"];
}

function policyFor(value: MemoryPolicy | unknown): MemoryPolicy {
  return memoryPolicyFromAgentPolicy(value);
}

/**
 * Decide retrieval with a small deterministic intent classifier. It deliberately
 * has no model call: the result is bounded, explainable, and safe to run before
 * a model budget is reserved. The token and phrase fixtures are the evaluation
 * seam for replacing this classifier later.
 */
export function decideMemoryRetrieval(
  message: string,
  options: { always?: boolean; policy?: MemoryPolicy | unknown } = {},
): RetrievalDecision {
  const policy = policyFor(options.policy);
  const query = message.trim().replace(/\s+/gu, " ").slice(0, 4_000);
  const sourceTypes = sourceTypesFor(policy);
  const base = { query, sourceTypes, maxResults: 8, maxTokens: policy.maxRetrievedTokens };
  if (options.always) return { requested: true, reason: "always", reasonCode: "always", ...base };
  if (policy.mode === "disabled") return { requested: false, reason: "policy_disabled", reasonCode: "policy_disabled", ...base };

  const tokens = normalizeTokens(query);
  const hasPersonalAnchor = tokens.some((token) => token === "my" || token === "our" || token === "me" || token === "we" || token === "i");
  const hasDirectReference = tokens.some((token) => directReferenceTerms.has(token));
  const hasPreferenceReference = (hasPersonalAnchor && tokens.some((token) => preferenceTerms.has(token)))
    || includesPhrase(tokens, ["what", "do", "you", "know", "about", "me"]);
  const hasContextualQuestion = includesPhrase(tokens, ["what", "did", "we"])
    || includesPhrase(tokens, ["where", "were", "we"])
    || includesPhrase(tokens, ["pick", "up"])
    || includesPhrase(tokens, ["remind", "me"])
    || includesPhrase(tokens, ["have", "i", "told", "you"])
    || includesPhrase(tokens, ["did", "i", "mention"])
    || tokens.includes("continue")
    || tokens.includes("resume");
  const hasSemanticReference = tokens.some((token) => semanticReferenceTerms.has(token));
  const hasKnowledgeReference = tokens.some((token) => knowledgeReferenceTerms.has(token));

  const reason: RetrievalReason | undefined = hasPreferenceReference
    ? "preference_reference"
    : hasContextualQuestion
      ? "contextual_question"
      : hasDirectReference
        ? "direct_reference"
        : hasSemanticReference
          ? "semantic_reference"
          : hasKnowledgeReference
            ? "knowledge_reference"
            : undefined;
  if (!reason) return { requested: false, reason: "not_requested", reasonCode: "not_requested", ...base };
  return { requested: true, reason, reasonCode: reason, ...base };
}

function normalizedText(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function boundedScore(value: unknown): number {
  const score = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(score) || score < 0) return 0;
  return Math.min(1, score);
}

function rankEvidence(
  memoryMatches: MemoryRecord[],
  knowledgeMatches: KnowledgeChunkRecord[],
  maxResults: number,
  maxTokens: number,
): RetrievalEvidence[] {
  const candidates: RetrievalEvidence[] = [
    ...memoryMatches.map((record) => ({
      sourceType: "memory" as const,
      id: record.id,
      text: record.canonical_text,
      score: boundedScore(record.relevance_score),
      rank: 0,
      namespace: record.namespace,
      provenance: record.provenance,
    })),
    ...knowledgeMatches.map((chunk) => ({
      sourceType: "knowledge" as const,
      id: chunk.id,
      text: chunk.canonical_text,
      score: boundedScore(chunk.relevance_score),
      rank: 0,
      sourceId: chunk.source_id,
      chunkIndex: chunk.chunk_index,
      provenance: chunk.provenance,
    })),
  ];
  const unique = new Map<string, RetrievalEvidence>();
  for (const candidate of candidates) {
    const key = normalizedText(candidate.text);
    const existing = unique.get(key);
    if (!existing || candidate.score > existing.score) unique.set(key, candidate);
  }
  const sorted = [...unique.values()].sort((left, right) => right.score - left.score || left.sourceType.localeCompare(right.sourceType) || left.id.localeCompare(right.id));
  const selected: RetrievalEvidence[] = [];
  let selectedTokens = 0;
  const sourceCount = new Map<RetrievalSourceType, number>();
  for (const candidate of sorted) {
    if (selected.length >= maxResults) break;
    const count = sourceCount.get(candidate.sourceType) ?? 0;
    if (sorted.some((entry) => entry.sourceType !== candidate.sourceType) && count >= Math.ceil(maxResults / 2)) continue;
    const remainingTokens = maxTokens - selectedTokens;
    if (remainingTokens <= 0) break;
    const candidateTokens = Math.ceil(candidate.text.length / 4);
    if (candidateTokens > remainingTokens && selected.length > 0) continue;
    const text = candidateTokens > remainingTokens
      ? candidate.text.slice(0, Math.max(1, remainingTokens * 4)).trimEnd()
      : candidate.text;
    sourceCount.set(candidate.sourceType, count + 1);
    selected.push({ ...candidate, text, rank: selected.length + 1 });
    selectedTokens += Math.ceil(text.length / 4);
  }
  return selected;
}

export class RetrievalService {
  public constructor(
    private readonly memory: MemoryLifecycle,
    private readonly knowledge: KnowledgeRepository,
  ) {}

  public async retrieve(scope: MemoryScope, message: string, policyValue: MemoryPolicy | unknown, options: { always?: boolean } = {}): Promise<RetrievalResult> {
    const decision = decideMemoryRetrieval(message, { ...options, policy: policyValue });
    if (!decision.requested) return { decision, evidence: [], memoryMatches: [], knowledgeMatches: [] };
    const started = performance.now();
    try {
      const candidateLimit = Math.min(50, Math.max(decision.maxResults, decision.maxResults * 2));
      const [memoryMatches, knowledgeMatches] = await Promise.all([
        decision.sourceTypes.includes("memory") ? this.memory.search(scope, decision.query, policyValue, candidateLimit) : Promise.resolve([]),
        decision.sourceTypes.includes("knowledge") ? this.knowledge.search(scope, decision.query, candidateLimit) : Promise.resolve([]),
      ]);
      return {
        decision,
        evidence: rankEvidence(memoryMatches, knowledgeMatches, decision.maxResults, decision.maxTokens),
        memoryMatches,
        knowledgeMatches,
      };
    } finally {
      recordRetrievalDuration(performance.now() - started);
    }
  }
}

export function retrievalGate(message: string, options: { always?: boolean; policy?: MemoryPolicy | unknown } = {}): boolean {
  return decideMemoryRetrieval(message, options).requested;
}
