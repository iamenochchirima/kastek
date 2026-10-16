import { createHash } from "node:crypto";
import type { MemoryRevisionRecord } from "./revisions";

export type RetentionRuleScope = "organization" | "workspace" | "namespace" | "memory_type" | "record";
export type QualityEventType = "usage" | "confirmation" | "correction" | "rejection" | "helpfulness" | "revalidation_requested" | "revalidation_completed";
export type MemoryConflictType = "fact_key" | "entity_overlap" | "validity_overlap" | "explicit_correction";

export interface MemoryRetentionRule {
  scopeType: RetentionRuleScope;
  scopeId: string;
  namespace?: string;
  memoryType?: "semantic" | "episodic";
  factId?: string;
  retentionDays: number;
  revalidateAfterDays: number;
  revision?: number;
}

export interface OrganizationRetentionDefaults {
  memoryDays: number;
  revalidateAfterDays: number;
  revision: number;
}

export interface RetentionEvaluationInput {
  organizationId: string;
  workspaceId: string;
  namespace: string;
  memoryType: "semantic" | "episodic";
  factId: string;
  observedAt: string;
  lastRevalidatedAt?: string;
  rules: readonly MemoryRetentionRule[];
  organizationDefaults: OrganizationRetentionDefaults;
  now?: Date;
}

export interface RetentionEvaluation {
  source: RetentionRuleScope | "organization_default";
  ruleRevision: number;
  retentionDays: number;
  revalidateAfterDays: number;
  expiresAt: string;
  revalidateAt: string;
  expired: boolean;
  stale: boolean;
}

function date(value: string, field: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`${field.toUpperCase()}_INVALID`);
  return parsed;
}

function boundedDays(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_650) throw new Error(`${field.toUpperCase()}_INVALID`);
  return value;
}

/**
 * Rules are selected by explicit specificity. A broad organization rule can
 * never win over a record-level rule, even if it was edited more recently.
 */
export function selectRetentionRule(input: RetentionEvaluationInput): { rule: MemoryRetentionRule | null; source: RetentionEvaluation["source"] } {
  const candidates = input.rules.filter((rule) => {
    if (rule.scopeType === "record") return rule.factId === input.factId && rule.scopeId === input.factId;
    if (rule.scopeType === "namespace") return rule.scopeId === input.workspaceId && rule.namespace === input.namespace;
    if (rule.scopeType === "memory_type") return rule.scopeId === input.workspaceId && rule.memoryType === input.memoryType;
    if (rule.scopeType === "workspace") return rule.scopeId === input.workspaceId;
    return rule.scopeId === input.organizationId;
  });
  const precedence: Record<RetentionRuleScope, number> = {
    organization: 1,
    workspace: 2,
    memory_type: 3,
    namespace: 4,
    record: 5,
  };
  const rule = [...candidates].sort((left, right) => (
    precedence[right.scopeType] - precedence[left.scopeType]
    || (right.revision ?? 0) - (left.revision ?? 0)
    || left.scopeId.localeCompare(right.scopeId)
  ))[0] ?? null;
  return { rule, source: rule?.scopeType ?? "organization_default" };
}

export function evaluateRetention(input: RetentionEvaluationInput): RetentionEvaluation {
  const observedAt = date(input.observedAt, "observed_at");
  const now = input.now ?? new Date();
  const { rule, source } = selectRetentionRule(input);
  const retentionDays = boundedDays(rule?.retentionDays ?? input.organizationDefaults.memoryDays, "retention_days");
  const revalidateAfterDays = boundedDays(rule?.revalidateAfterDays ?? input.organizationDefaults.revalidateAfterDays, "revalidate_after_days");
  const expiresAt = new Date(observedAt.getTime() + retentionDays * 86_400_000);
  const revalidateBase = input.lastRevalidatedAt ? date(input.lastRevalidatedAt, "last_revalidated_at") : observedAt;
  const revalidateAt = new Date(revalidateBase.getTime() + revalidateAfterDays * 86_400_000);
  return {
    source,
    ruleRevision: rule?.revision ?? input.organizationDefaults.revision,
    retentionDays,
    revalidateAfterDays,
    expiresAt: expiresAt.toISOString(),
    revalidateAt: revalidateAt.toISOString(),
    expired: expiresAt.getTime() <= now.getTime(),
    stale: revalidateAt.getTime() <= now.getTime(),
  };
}

export interface MemoryQualityTotals {
  usage: number;
  confirmations: number;
  corrections: number;
  rejections: number;
  helpfulness: number;
}

/** Decay is a ranking/revalidation signal only; it never changes lifecycle truth. */
export function memoryDecayScore(input: {
  observedAt: string;
  quality?: Partial<MemoryQualityTotals>;
  confidence?: number;
  now?: Date;
  halfLifeDays?: number;
}): number {
  const observedAt = date(input.observedAt, "observed_at");
  const now = input.now ?? new Date();
  const halfLifeDays = input.halfLifeDays ?? 180;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) throw new Error("HALF_LIFE_DAYS_INVALID");
  const ageDays = Math.max(0, (now.getTime() - observedAt.getTime()) / 86_400_000);
  const recency = Math.exp(-Math.LN2 * ageDays / halfLifeDays);
  const quality = input.quality ?? {};
  const usageBoost = Math.min(0.2, Math.log1p(Math.max(0, quality.usage ?? 0)) * 0.025);
  const confirmationBoost = Math.min(0.2, Math.max(0, quality.confirmations ?? 0) * 0.04);
  const correctionPenalty = Math.min(0.25, Math.max(0, quality.corrections ?? 0) * 0.08);
  const rejectionPenalty = Math.min(0.3, Math.max(0, quality.rejections ?? 0) * 0.12);
  const helpfulness = Math.max(-1, Math.min(1, quality.helpfulness ?? 0));
  const helpfulnessAdjustment = helpfulness * 0.1;
  const confidence = input.confidence === undefined ? 0.5 : Math.max(0, Math.min(1, input.confidence));
  return Math.max(0, Math.min(1, recency * (0.55 + confidence * 0.25 + usageBoost + confirmationBoost + helpfulnessAdjustment - correctionPenalty - rejectionPenalty)));
}

export interface ConflictRevisionCandidate {
  revisionId: string;
  factId: string;
  factKey: string;
  subjectKey: string;
  predicateKey: string;
  canonicalText: string;
  lifecycleState: MemoryRevisionRecord["lifecycleState"];
  transitionType: MemoryRevisionRecord["transitionType"];
  predecessorRevisionId?: string;
  validFrom: string;
  validTo?: string;
  provenance?: Record<string, unknown>;
}

export interface MemoryConflictCandidate {
  leftRevisionId: string;
  rightRevisionId: string;
  conflictType: MemoryConflictType;
  conflictKey: string;
  resolved: boolean;
}

function normalizedText(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function intervalsOverlap(left: ConflictRevisionCandidate, right: ConflictRevisionCandidate): boolean {
  const leftStart = date(left.validFrom, "valid_from").getTime();
  const rightStart = date(right.validFrom, "valid_from").getTime();
  const leftEnd = left.validTo ? date(left.validTo, "valid_to").getTime() : Number.POSITIVE_INFINITY;
  const rightEnd = right.validTo ? date(right.validTo, "valid_to").getTime() : Number.POSITIVE_INFINITY;
  return leftStart < rightEnd && rightStart < leftEnd;
}

function conflictKey(leftRevisionId: string, rightRevisionId: string, type: MemoryConflictType): string {
  const [left, right] = [leftRevisionId, rightRevisionId].sort();
  return createHash("sha256").update(`${type}:${left}:${right}`).digest("hex");
}

/**
 * Finds only contradictory values. Identical assertions and already
 * superseded/expired/deleted revisions are not conflicts. Explicit correction
 * lineage is recorded as resolved evidence, while independent overlapping
 * values remain open for review.
 */
export function detectMemoryConflicts(candidates: readonly ConflictRevisionCandidate[]): MemoryConflictCandidate[] {
  const visible = candidates.filter((candidate) => ["active", "review_pending"].includes(candidate.lifecycleState));
  const result = new Map<string, MemoryConflictCandidate>();
  for (let leftIndex = 0; leftIndex < visible.length; leftIndex += 1) {
    const left = visible[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < visible.length; rightIndex += 1) {
      const right = visible[rightIndex]!;
      if (normalizedText(left.canonicalText) === normalizedText(right.canonicalText)) continue;
      if (!intervalsOverlap(left, right)) continue;
      const concurrentCorrection = left.provenance?.conflictType === "concurrent_correction"
        || right.provenance?.conflictType === "concurrent_correction";
      const explicitCorrection = !concurrentCorrection && (left.predecessorRevisionId === right.revisionId || right.predecessorRevisionId === left.revisionId
        || (left.factId === right.factId && (left.transitionType === "correction" || right.transitionType === "correction")));
      const sameFactKey = left.factKey === right.factKey;
      const sameEntity = left.subjectKey === right.subjectKey && left.predicateKey === right.predicateKey;
      // A declared correction is its own resolved lineage signal. It must not
      // also create an open contradiction against the predecessor, otherwise
      // a valid correction would be hidden from retrieval.
      const types: MemoryConflictType[] = explicitCorrection
        ? ["explicit_correction"]
        : concurrentCorrection
          ? ["fact_key"]
        : [
          ...(sameFactKey ? ["fact_key" as const] : []),
          ...(sameEntity ? ["entity_overlap" as const] : []),
          "validity_overlap",
        ];
      for (const type of types) {
        const key = conflictKey(left.revisionId, right.revisionId, type);
        result.set(key, {
          leftRevisionId: left.revisionId,
          rightRevisionId: right.revisionId,
          conflictType: type,
          conflictKey: key,
          resolved: type === "explicit_correction",
        });
      }
    }
  }
  return [...result.values()].sort((left, right) => left.conflictKey.localeCompare(right.conflictKey));
}
