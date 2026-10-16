import { describe, expect, it } from "vitest";
import { reconcileRunUsage, type LocalRunBudget, type LocalRunUsage } from "../src/operations/usage-reconciliation";

const localUsage: LocalRunUsage = {
  modelCalls: 1,
  inputTokens: 10,
  outputTokens: 5,
  totalTokens: 15,
  estimatedCostUsd: 0.02,
};

const localBudget: LocalRunBudget = {
  reservations: 1,
  reserved: 0,
  captured: 1,
  released: 0,
  unknown: 0,
  reconciliationRequired: 0,
  estimatedTokens: 20,
  estimatedCostUsd: 0.03,
  capturedTokens: 15,
  capturedCostUsd: 0.02,
};

const reservations = [{
  id: "reservation-1",
  actionKey: "ai.model_call",
  estimatedCredits: 30,
  capturedCredits: 20,
  releasedCredits: 10,
  status: "CAPTURED",
  sourceType: "AGENT_RUN",
  sourceId: "run-1",
  pricingVersion: "v1",
  expiresAt: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:01.000Z",
}];

const usageEvents = [{
  id: "usage-1",
  reservationId: "reservation-1",
  actionKey: "ai.model_call",
  creditsCharged: 20,
  status: "COMPLETED",
  provider: "openrouter",
  model: "openai/gpt-4o-mini",
  inputTokens: 10,
  outputTokens: 5,
  pricingVersion: "v1",
  providerCostUsd: 0.02,
  createdAt: "2026-09-01T00:00:01.000Z",
}];

describe("run usage reconciliation", () => {
  it("matches provider tokens and Core billing to the captured reservation", () => {
    const report = reconcileRunUsage({ localUsage, localBudget, reservations, usageEvents });

    expect(report.status).toBe("matched");
    expect(report.billed.reservations).toMatchObject({ count: 1, estimatedCredits: 30, capturedCredits: 20, releasedCredits: 10, byStatus: { CAPTURED: 1 } });
    expect(report.billed.usage).toMatchObject({ eventCount: 1, creditsCharged: 20, inputTokens: 10, outputTokens: 5, missingTokenEvents: 0, providerCostUsd: 0.02, missingProviderCostEvents: 0 });
    expect(report.comparisons).toEqual({ uncoveredLocalModelCalls: 0, providerTokenUsageMatches: true, providerCostUsageMatches: true, usageEventReservationMatches: true });
  });

  it("reports pending while a local reservation is unknown", () => {
    const report = reconcileRunUsage({
      localUsage,
      localBudget: { ...localBudget, unknown: 1, reconciliationRequired: 1 },
      reservations,
      usageEvents,
    });

    expect(report.status).toBe("pending");
  });

  it("reports a mismatch when billed provider tokens do not match the Agents ledger", () => {
    const report = reconcileRunUsage({
      localUsage,
      localBudget,
      reservations,
      usageEvents: [{ ...usageEvents[0]!, outputTokens: 8 }],
    });

    expect(report.status).toBe("mismatch");
    expect(report.comparisons.providerTokenUsageMatches).toBe(false);
  });

  it("reports a mismatch when Core provider cost does not match the local billable ledger", () => {
    const report = reconcileRunUsage({
      localUsage,
      localBudget,
      reservations,
      usageEvents: [{ ...usageEvents[0]!, providerCostUsd: 0.03 }],
    });

    expect(report.status).toBe("mismatch");
    expect(report.comparisons.providerCostUsageMatches).toBe(false);
  });

  it("distinguishes an intentionally unbilled run from a matched billed run", () => {
    const report = reconcileRunUsage({ localUsage, localBudget: { ...localBudget, captured: 0, capturedTokens: 0, capturedCostUsd: 0 }, reservations: [], usageEvents: [] });

    expect(report.status).toBe("no_billed_usage");
    expect(report.comparisons.uncoveredLocalModelCalls).toBe(1);
    expect(report.comparisons.providerTokenUsageMatches).toBeNull();
    expect(report.comparisons.providerCostUsageMatches).toBeNull();
  });
});
