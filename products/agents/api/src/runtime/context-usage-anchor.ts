import type { ContextMeasurementBasis } from "./context-planning";

export type ContextAnchorInvalidationReason =
  | "provider_changed"
  | "model_changed"
  | "endpoint_changed"
  | "manifest_changed"
  | "source_boundary_changed"
  | "compaction_generation_changed"
  | "input_delta_exceeded";

/**
 * Content-free evidence that ties provider usage to one exact request
 * boundary. It is safe to persist in the journal alongside model-attempt
 * metadata; prompts, tool schemas, and provider credentials never enter it.
 */
export interface ContextUsageAnchor {
  readonly schemaVersion: "v1";
  readonly operationKey: string;
  readonly provider: string;
  readonly model: string;
  readonly endpointId?: string;
  readonly manifestDigest: string;
  readonly sourceDigest: string;
  readonly compactionGeneration: number;
  readonly estimatedInputTokens: number;
  readonly providerInputTokens: number;
  readonly providerOutputTokens: number;
  readonly providerTotalTokens: number;
  readonly recordedAt: string;
}

export interface ContextUsageAnchorBoundary {
  readonly provider: string;
  readonly model: string;
  readonly endpointId?: string;
  readonly manifestDigest: string;
  readonly sourceDigest: string;
  readonly compactionGeneration: number;
}

export interface ContextUsageAnchorValidation {
  readonly valid: boolean;
  readonly reasons: readonly ContextAnchorInvalidationReason[];
}

export interface AnchoredInputMeasurement {
  readonly inputTokens: number;
  readonly basis: Extract<ContextMeasurementBasis, "anchored_estimate" | "full_estimate">;
  readonly anchorOperationKey?: string;
  readonly reason?: ContextAnchorInvalidationReason;
}

export function createContextUsageAnchor(input: {
  readonly operationKey: string;
  readonly boundary: ContextUsageAnchorBoundary;
  readonly estimatedInputTokens: number;
  readonly providerInputTokens: number;
  readonly providerOutputTokens: number;
  readonly providerTotalTokens: number;
  readonly recordedAt?: string;
}): ContextUsageAnchor {
  assertNonEmpty(input.operationKey, "operationKey");
  assertNonEmpty(input.boundary.provider, "provider");
  assertNonEmpty(input.boundary.model, "model");
  assertNonEmpty(input.boundary.manifestDigest, "manifestDigest");
  assertNonEmpty(input.boundary.sourceDigest, "sourceDigest");
  assertNonNegativeInteger(input.boundary.compactionGeneration, "compactionGeneration");
  assertNonNegativeInteger(input.estimatedInputTokens, "estimatedInputTokens");
  assertNonNegativeInteger(input.providerInputTokens, "providerInputTokens");
  assertNonNegativeInteger(input.providerOutputTokens, "providerOutputTokens");
  assertNonNegativeInteger(input.providerTotalTokens, "providerTotalTokens");
  return {
    schemaVersion: "v1",
    operationKey: input.operationKey,
    provider: input.boundary.provider,
    model: input.boundary.model,
    ...(input.boundary.endpointId ? { endpointId: input.boundary.endpointId } : {}),
    manifestDigest: input.boundary.manifestDigest,
    sourceDigest: input.boundary.sourceDigest,
    compactionGeneration: input.boundary.compactionGeneration,
    estimatedInputTokens: input.estimatedInputTokens,
    providerInputTokens: input.providerInputTokens,
    providerOutputTokens: input.providerOutputTokens,
    providerTotalTokens: input.providerTotalTokens,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
  };
}

export function validateContextUsageAnchor(anchor: ContextUsageAnchor, boundary: ContextUsageAnchorBoundary): ContextUsageAnchorValidation {
  const reasons: ContextAnchorInvalidationReason[] = [];
  if (anchor.provider !== boundary.provider) reasons.push("provider_changed");
  if (anchor.model !== boundary.model) reasons.push("model_changed");
  if (anchor.endpointId !== boundary.endpointId) reasons.push("endpoint_changed");
  if (anchor.manifestDigest !== boundary.manifestDigest) reasons.push("manifest_changed");
  if (anchor.sourceDigest !== boundary.sourceDigest) reasons.push("source_boundary_changed");
  if (anchor.compactionGeneration !== boundary.compactionGeneration) reasons.push("compaction_generation_changed");
  return { valid: reasons.length === 0, reasons };
}

/**
 * Reuses a provider measurement only within the same durable source boundary.
 * When the exact manifest changed, the anchor can contribute only a bounded
 * estimate delta. Any invalid or unbounded reuse falls back to a fresh full
 * estimate instead of presenting stale provider usage as authoritative.
 */
export function measureInputFromAnchor(input: {
  readonly anchor: ContextUsageAnchor | undefined;
  readonly boundary: ContextUsageAnchorBoundary;
  readonly estimatedInputTokens: number;
  readonly maxDeltaTokens: number;
}): AnchoredInputMeasurement {
  const fullEstimate = { inputTokens: input.estimatedInputTokens, basis: "full_estimate" as const };
  if (!input.anchor) return fullEstimate;
  const validation = validateContextUsageAnchor(input.anchor, input.boundary);
  if (!validation.valid) return { ...fullEstimate, reason: validation.reasons[0] };
  const delta = input.estimatedInputTokens - input.anchor.estimatedInputTokens;
  if (!Number.isInteger(input.maxDeltaTokens) || input.maxDeltaTokens < 0 || Math.abs(delta) > input.maxDeltaTokens) {
    return { ...fullEstimate, reason: "input_delta_exceeded" };
  }
  return {
    inputTokens: Math.max(0, input.anchor.providerInputTokens + delta),
    basis: "anchored_estimate",
    anchorOperationKey: input.anchor.operationKey,
  };
}

function assertNonEmpty(value: string, name: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
}
