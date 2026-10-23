import { createHash } from "node:crypto";
import type { OperationsRule, OperationsSignal } from "@kasitek-labs/contracts";
import type { Source } from "./config.js";
export const defaultCatalogue = [
  ["source.available", "1", 0, 3, "critical"],
  ["publication.overdue_seconds", "300", 0, 2, "warning"],
  ["publication.quarantined", "0", 0, 2, "warning"],
  ["projection.overdue_seconds", "300", 0, 2, "warning"],
  ["ingress.quarantined", "0", 0, 2, "warning"],
  ["execution.dispatch_overdue_seconds", "120", 0, 2, "warning"],
  ["execution.failure_rate_bps", "2000", 20, 2, "critical"],
  ["recovery.pending_age_seconds", "900", 0, 2, "warning"],
] as const;
export function defaults(source: Source): OperationsRule[] {
  return defaultCatalogue.map(
    ([signalKey, threshold, minimumSamples, breachCount, severity]) => ({
      id: `${source}:${signalKey}`,
      source,
      signalKey,
      enabled: true,
      threshold,
      minimumSamples,
      breachCount,
      recoveryCount: 2,
      severity,
      revision: 1,
    }),
  );
}
export function fingerprint(
  environment: string,
  source: string,
  key: string,
  group: string,
): string {
  return createHash("sha256")
    .update(JSON.stringify([environment, source, key, group]))
    .digest("hex");
}
export type Condition = "breached" | "healthy" | "unknown";
export function measure(
  rule: OperationsRule,
  signal: OperationsSignal,
): Condition {
  if (signal.status === "no_activity" && signal.coverage === "complete")
    return "healthy";
  if (
    signal.status !== "available" ||
    signal.coverage !== "complete" ||
    signal.value === null ||
    !/^\d{1,30}$/.test(signal.value)
  )
    return "unknown";
  if (
    rule.minimumSamples > 0 &&
    (!signal.denominator ||
      !/^\d{1,30}$/.test(signal.denominator) ||
      BigInt(signal.denominator) < BigInt(rule.minimumSamples))
  )
    return "unknown";
  const value = BigInt(signal.value),
    threshold = BigInt(rule.threshold);
  return rule.signalKey === "source.available"
    ? value < threshold
      ? "breached"
      : "healthy"
    : value > threshold ||
        (signal.unit === "basis_points" && value === threshold)
      ? "breached"
      : "healthy";
}
export function advance(
  previous: {
    breaches: number;
    recoveries: number;
    revision: number;
  } | null,
  condition: Condition,
  revision: number,
): {
  breaches: number;
  recoveries: number;
} {
  const p = previous?.revision === revision ? previous : null;
  return {
    breaches: condition === "breached" ? (p?.breaches ?? 0) + 1 : 0,
    recoveries: condition === "healthy" ? (p?.recoveries ?? 0) + 1 : 0,
  };
}
