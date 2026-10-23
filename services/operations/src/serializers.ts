import {measurementSummary} from "./monitor-coverage.js";
import type {
  OperationsIncident,
  OperationsRule,
  OperationsMonitor,
  OperationsTransition,
} from "@kasitek-labs/contracts";
export type Row = Record<string, any>;
export function iso(v: any): string | null {
  return v == null ? null : new Date(v).toISOString();
}
export function incident(r: Row): OperationsIncident {
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    environment: r.environment,
    source: r.source,
    signalKey: r.signal_key,
    group: r.group_key,
    severity: r.severity,
    status: r.status,
    condition: r.condition,
    assignedTo: r.assigned_to,
    revision: r.revision,
    openedAt: iso(r.opened_at)!,
    updatedAt: iso(r.updated_at)!,
    resolvedAt: iso(r.resolved_at),
    previousIncidentId: r.previous_incident_id,
    evidence: r.evidence,
    value: r.value,
    ruleRevision: r.rule_revision,
    observedAt: iso(r.observed_at),
  };
}
export function rule(r: Row): OperationsRule {
  return {
    id: r.id,
    source: r.source,
    signalKey: r.signal_key,
    enabled: r.enabled,
    threshold: r.threshold,
    minimumSamples: r.minimum_samples,
    breachCount: r.breach_count,
    recoveryCount: r.recovery_count,
    severity: r.severity,
    revision: r.revision,
  };
}
export function monitor(r: Row): OperationsMonitor {
  return {
    id: r.id,
    source: r.source,
    origin: r.origin,
    enabled: r.enabled,
    intervalSeconds: r.interval_seconds,
    lastObservedAt: iso(r.last_observed_at),
    lastError: r.last_error,
    nextPollAt: iso(r.next_poll_at)!,
    leaseUntil: iso(r.lease_until),
    measurementSummary:measurementSummary(r.signal_statuses),
  };
}
export function transition(r: Row): OperationsTransition {
  return {
    id: r.id,
    incidentId: r.incident_id,
    action: r.action,
    actorId: r.actor_id,
    reason: r.reason,
    createdAt: iso(r.created_at)!,
    revision: r.revision,
  };
}
