import type {
  MemoryEvidencePack,
  MemoryEvidencePackItem,
  MemoryKind,
  MemoryRetrievalPlan,
  MemoryScope,
} from "./contracts";

export type RetrievalRelationType = "supports" | "contradicts" | "supersedes" | "derived_from" | "about";

export interface RetrievalRelationSummary {
  readonly relationType: RetrievalRelationType;
  readonly relatedRevisionId: string;
}

export type RetrievalIntent =
  | "none"
  | "current_fact"
  | "historical_episode"
  | "semantic_context"
  | "procedural"
  | "all_memory";

export interface RetrievalPlanInput {
  scope: MemoryScope;
  query: string;
  intent: RetrievalIntent;
  decision?: "requested" | "required";
  maxResults?: number;
  maxTokens?: number;
  reason?: string;
  plannerVersion?: string;
  readableNamespaces?: readonly MemoryScope["namespace"][];
}

export interface RetrievalCandidate {
  revisionId: string;
  text: string;
  kind: MemoryKind;
  /** Stable canonical identity used to merge current revisions. */
  factKey?: string;
  subjectKey?: string;
  predicateKey?: string;
  scope: MemoryScope;
  lifecycle: "active" | "superseded" | "expired" | "deleted" | "review_pending" | "quarantined";
  readiness: "visible" | "accepted" | "committed" | "indexed";
  sources: MemoryEvidencePackItem["sources"];
  validFrom?: string;
  validTo?: string;
  confidence?: number;
  sensitivity?: "normal" | "sensitive" | "restricted";
  lexicalScore?: number;
  semanticScore?: number;
  factKeyMatch?: number;
  sourceTrust?: number;
  contradictionPenalty?: number;
  usageCount?: number;
  /** Bounded temporal/quality signal; it never changes lifecycle truth. */
  decayScore?: number;
  /** Content-free lineage used to explain historical and contradictory results. */
  relations?: readonly RetrievalRelationSummary[];
  selectionReason?: string;
}

export const RETRIEVAL_PLANNER_VERSION = "typed-v1" as const;

const intentKinds: Record<Exclude<RetrievalIntent, "none">, MemoryKind[]> = {
  current_fact: ["semantic"],
  historical_episode: ["episodic"],
  semantic_context: ["semantic", "episodic"],
  procedural: ["procedural"],
  all_memory: ["semantic", "episodic", "working", "procedural"],
};

function boundInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function freshnessFor(intent: RetrievalIntent): MemoryRetrievalPlan["freshness"] {
  if (intent === "current_fact" || intent === "procedural") return "current";
  if (intent === "historical_episode") return "historical";
  return "any";
}

export function buildRetrievalPlan(input: RetrievalPlanInput): MemoryRetrievalPlan {
  const query = input.query.trim().replace(/\s+/gu, " ").slice(0, 4_000);
  const decision = input.intent === "none" ? "not_requested" : input.decision ?? "requested";
  const readableNamespaces = [...new Set(
    (input.readableNamespaces ?? input.scope.readableNamespaces ?? []).filter((namespace): namespace is MemoryScope["namespace"] =>
      namespace === "conversation"
      || namespace === "end_user_private"
      || namespace === "workspace_shared"
      || namespace === "agent_private"
      || namespace === "procedural"
      || namespace === "knowledge",
    ),
  )];
  return {
    scope: input.scope,
    decision,
    query,
    memoryKinds: input.intent === "none" ? [] : intentKinds[input.intent],
    freshness: freshnessFor(input.intent),
    maxResults: boundInteger(input.maxResults, 8, 1, 50),
    maxTokens: boundInteger(input.maxTokens, 1_600, 256, 8_000),
    reason: (input.reason ?? input.intent).trim().slice(0, 160),
    plannerVersion: input.plannerVersion ?? RETRIEVAL_PLANNER_VERSION,
    ...(readableNamespaces.length ? { readableNamespaces } : {}),
  };
}

function normalizedScore(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function scopeSpecificity(candidate: MemoryScope, requested: MemoryScope): number {
  if (candidate.organizationId !== requested.organizationId || candidate.workspaceId !== requested.workspaceId) return 0;
  if (candidate.agentDefinitionId !== requested.agentDefinitionId || candidate.installationId !== requested.installationId) return 0;
  if (candidate.namespace === "conversation") {
    return candidate.conversationId && requested.conversationId && candidate.conversationId === requested.conversationId ? 1 : 0;
  }
  if (candidate.namespace === "end_user_private") {
    return candidate.endUserId && requested.endUserId && candidate.endUserId === requested.endUserId ? 1 : 0;
  }
  if (candidate.namespace === "agent_private" || candidate.namespace === "procedural") return 0.85;
  if (candidate.namespace === "workspace_shared") return 0.7;
  return 0;
}

function validForPlan(candidate: RetrievalCandidate, plan: MemoryRetrievalPlan, now: number): boolean {
  if (candidate.lifecycle !== "active" || candidate.readiness !== "visible") return false;
  if (!plan.memoryKinds.includes(candidate.kind)) return false;
  if (plan.readableNamespaces?.length && !plan.readableNamespaces.includes(candidate.scope.namespace)) return false;
  if (scopeSpecificity(candidate.scope, plan.scope) === 0) return false;
  if (candidate.validTo && new Date(candidate.validTo).getTime() <= now && plan.freshness !== "historical") return false;
  if (plan.freshness === "current" && candidate.validFrom && new Date(candidate.validFrom).getTime() > now) return false;
  return true;
}

function candidateScore(candidate: RetrievalCandidate, plan: MemoryRetrievalPlan, now: number): number {
  const ageDays = candidate.validFrom ? Math.max(0, (now - new Date(candidate.validFrom).getTime()) / 86_400_000) : 0;
  const freshness = candidate.decayScore === undefined
    ? Math.max(0, Math.min(1, 1 - ageDays / 365))
    : normalizedScore(candidate.decayScore);
  const score = normalizedScore(candidate.lexicalScore) * 0.25
    + normalizedScore(candidate.semanticScore) * 0.25
    + normalizedScore(candidate.factKeyMatch) * 0.2
    + scopeSpecificity(candidate.scope, plan.scope) * 0.12
    + freshness * 0.08
    + normalizedScore(candidate.sourceTrust ?? 0.5) * 0.05
    + normalizedScore(candidate.confidence) * 0.05
    + Math.min(0.05, Math.max(0, candidate.usageCount ?? 0) / 2000);
  return Math.max(0, Math.min(1, score - normalizedScore(candidate.contradictionPenalty) * 0.3));
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/**
 * Ranks already-authorized candidates. Authorization and lifecycle filtering
 * happen before ranking; this function never turns an inaccessible or pending
 * record into model evidence.
 */
export function rankEvidencePack(
  plan: MemoryRetrievalPlan,
  candidates: readonly RetrievalCandidate[],
  now = Date.now(),
): MemoryEvidencePack {
  if (plan.decision === "not_requested") {
    return { plan, items: [], measuredTokens: 0, measurementBasis: "full_estimate" };
  }
  const deduplicated = new Map<string, RetrievalCandidate>();
  for (const candidate of candidates) {
    if (!validForPlan(candidate, plan, now)) continue;
    // Current-fact retrieval must return one authoritative revision per
    // stable fact identity. Historical retrieval deliberately preserves every
    // revision so callers can inspect the timeline.
    const identity = plan.freshness === "current" && candidate.factKey
      ? `fact:${candidate.factKey}`
      : `revision:${candidate.revisionId}`;
    const existing = deduplicated.get(identity);
    if (!existing || candidateScore(candidate, plan, now) > candidateScore(existing, plan, now)) {
      deduplicated.set(identity, candidate);
    }
  }
  const sorted = [...deduplicated.values()].sort((left, right) => {
    const difference = candidateScore(right, plan, now) - candidateScore(left, plan, now);
    return difference || left.revisionId.localeCompare(right.revisionId);
  });
  // Prefer independent evidence windows before spending the result budget on
  // repeated claims from one source event. This is a ranking tie-break, not an
  // authorization rule; all candidates were already scope/lifecycle checked.
  const sourceKeys = (candidate: RetrievalCandidate): string[] => {
    const keys = candidate.sources.map((source) => source.sourceEventId).filter(Boolean);
    return keys.length ? keys : [`revision:${candidate.revisionId}`];
  };
  const diverse: RetrievalCandidate[] = [];
  const remainder: RetrievalCandidate[] = [];
  const seenSources = new Set<string>();
  for (const candidate of sorted) {
    const sources = sourceKeys(candidate);
    if (sources.some((source) => !seenSources.has(source))) {
      diverse.push(candidate);
      sources.forEach((source) => seenSources.add(source));
    } else {
      remainder.push(candidate);
    }
  }
  const rankedCandidates = [...diverse, ...remainder];
  const items: MemoryEvidencePackItem[] = [];
  let measuredTokens = 0;
  for (const candidate of rankedCandidates) {
    if (items.length >= plan.maxResults) break;
    const candidateTokens = estimateTokens(candidate.text);
    if (measuredTokens + candidateTokens > plan.maxTokens) continue;
    const score = candidateScore(candidate, plan, now);
    items.push({
      revisionId: candidate.revisionId,
      text: candidate.text,
      score,
      rank: items.length + 1,
      kind: candidate.kind,
      scope: candidate.scope,
      sources: candidate.sources,
      ...(candidate.validFrom ? { validFrom: candidate.validFrom } : {}),
      ...(candidate.validTo ? { validTo: candidate.validTo } : {}),
      ...(candidate.confidence === undefined ? {} : { confidence: candidate.confidence }),
      selectionReason: candidate.selectionReason ?? plan.reason,
      ...(candidate.relations?.length ? { relations: candidate.relations } : {}),
    });
    measuredTokens += candidateTokens;
  }
  return { plan, items, measuredTokens, measurementBasis: "full_estimate" };
}
