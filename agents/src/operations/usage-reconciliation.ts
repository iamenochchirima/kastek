import type {
  CoreCreditReservationReconciliation,
  CoreCreditUsageReconciliationEvent,
} from "../core/client";

export interface LocalRunUsage {
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface LocalRunBudget {
  reservations: number;
  reserved: number;
  captured: number;
  released: number;
  unknown: number;
  reconciliationRequired: number;
  estimatedTokens: number;
  estimatedCostUsd: number;
  capturedTokens: number;
  capturedCostUsd: number;
}

export interface UsageReconciliationReport {
  status: "matched" | "pending" | "mismatch" | "no_billed_usage";
  local: {
    usage: LocalRunUsage;
    budget: LocalRunBudget;
  };
  billed: {
    reservations: {
      count: number;
      estimatedCredits: number;
      capturedCredits: number;
      releasedCredits: number;
      byStatus: Record<string, number>;
    };
    usage: {
      eventCount: number;
      creditsCharged: number;
      inputTokens: number;
      outputTokens: number;
      missingTokenEvents: number;
    };
  };
  comparisons: {
    uncoveredLocalModelCalls: number;
    providerTokenUsageMatches: boolean | null;
    usageEventReservationMatches: boolean | null;
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function sumOptional(values: Array<number | null | undefined>): number {
  return sum(values.filter((value): value is number => typeof value === "number"));
}

function reservationSummary(reservations: CoreCreditReservationReconciliation[]) {
  return {
    count: reservations.length,
    estimatedCredits: sum(reservations.map((reservation) => reservation.estimatedCredits)),
    capturedCredits: sum(reservations.map((reservation) => reservation.capturedCredits)),
    releasedCredits: sum(reservations.map((reservation) => reservation.releasedCredits)),
    byStatus: Object.fromEntries(
      [...new Set(reservations.map((reservation) => reservation.status))]
        .sort()
        .map((status) => [status, reservations.filter((reservation) => reservation.status === status).length]),
    ),
  };
}

function usageSummary(events: CoreCreditUsageReconciliationEvent[]) {
  return {
    eventCount: events.length,
    creditsCharged: sum(events.map((event) => event.creditsCharged)),
    inputTokens: sumOptional(events.map((event) => event.inputTokens)),
    outputTokens: sumOptional(events.map((event) => event.outputTokens)),
    missingTokenEvents: events.filter((event) => event.inputTokens === null || event.inputTokens === undefined || event.outputTokens === null || event.outputTokens === undefined).length,
  };
}

export function reconcileRunUsage(input: {
  localUsage: LocalRunUsage;
  localBudget: LocalRunBudget;
  reservations: CoreCreditReservationReconciliation[];
  usageEvents: CoreCreditUsageReconciliationEvent[];
}): UsageReconciliationReport {
  const billedReservations = reservationSummary(input.reservations);
  const billedUsage = usageSummary(input.usageEvents);
  const providerTokenUsageMatches = billedUsage.eventCount === 0
    ? null
    : billedUsage.missingTokenEvents > 0
      ? null
      : input.localUsage.inputTokens === billedUsage.inputTokens
        && input.localUsage.outputTokens === billedUsage.outputTokens;
  const reservationById = new Map(input.reservations.map((reservation) => [reservation.id, reservation]));
  const usageEventReservationMatches = billedUsage.eventCount === 0
    ? null
    : input.usageEvents.every((event) => {
      const reservation = reservationById.get(event.reservationId);
      return reservation !== undefined
        && reservation.status === "CAPTURED"
        && reservation.capturedCredits === event.creditsCharged;
    });
  const uncoveredLocalModelCalls = Math.max(0, input.localUsage.modelCalls - billedUsage.eventCount);
  const pending = input.localBudget.unknown > 0
    || input.localBudget.reconciliationRequired > 0
    || Object.entries(billedReservations.byStatus).some(([status, count]) => count > 0 && status !== "CAPTURED" && status !== "RELEASED");
  const hasMismatch = providerTokenUsageMatches === false || usageEventReservationMatches === false;

  return {
    status: hasMismatch
      ? "mismatch"
      : pending
        ? "pending"
        : billedUsage.eventCount === 0 && input.localUsage.modelCalls > 0
          ? "no_billed_usage"
          : "matched",
    local: { usage: input.localUsage, budget: input.localBudget },
    billed: { reservations: billedReservations, usage: billedUsage },
    comparisons: {
      uncoveredLocalModelCalls,
      providerTokenUsageMatches,
      usageEventReservationMatches,
    },
  };
}
