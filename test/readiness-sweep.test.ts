import { describe, expect, it, vi } from "vitest";
import { ReadinessSweep } from "../src/analytics/readiness-sweep";
import type { ReadinessRepository } from "../src/db/repositories/readiness-repository";

const candidate = {
  installationId: "installation-1",
  organizationId: "organization-1",
  actorId: "owner-1",
};

function repository() {
  return {
    claimDueEvaluations: vi.fn().mockResolvedValue([candidate]),
    completeEvaluation: vi.fn().mockResolvedValue(true),
    releaseEvaluation: vi.fn().mockResolvedValue(true),
  } as unknown as ReadinessRepository & {
    claimDueEvaluations: ReturnType<typeof vi.fn>;
    completeEvaluation: ReturnType<typeof vi.fn>;
    releaseEvaluation: ReturnType<typeof vi.fn>;
  };
}

describe("ReadinessSweep", () => {
  it("claims due installations and completes successful evaluations", async () => {
    const repositoryMock = repository();
    const evaluate = vi.fn().mockResolvedValue(undefined);
    const sweep = new ReadinessSweep(repositoryMock, {
      intervalMs: 30_000,
      batchSize: 10,
      leaseDurationMs: 60_000,
      owner: "sweep-test",
      evaluate,
    });
    const now = new Date("2026-08-22T12:00:00.000Z");

    await sweep.runOnce(now);

    expect(repositoryMock.claimDueEvaluations).toHaveBeenCalledWith({ owner: "sweep-test", limit: 10, leaseDurationMs: 60_000, now });
    expect(evaluate).toHaveBeenCalledWith(candidate);
    expect(repositoryMock.completeEvaluation).toHaveBeenCalledWith({
      installationId: candidate.installationId,
      owner: "sweep-test",
      evaluatedAt: now,
      nextEvaluationAt: new Date("2026-08-22T12:00:30.000Z"),
    });
    expect(repositoryMock.releaseEvaluation).not.toHaveBeenCalled();
  });

  it("releases failed evaluations for a bounded retry", async () => {
    const repositoryMock = repository();
    const evaluate = vi.fn().mockRejectedValue(new Error("projection unavailable"));
    const onError = vi.fn();
    const sweep = new ReadinessSweep(repositoryMock, {
      intervalMs: 30_000,
      batchSize: 10,
      leaseDurationMs: 60_000,
      retryDelayMs: 5_000,
      owner: "sweep-test",
      evaluate,
      onError,
    });
    const now = new Date("2026-08-22T12:00:00.000Z");

    await sweep.runOnce(now);

    expect(onError).toHaveBeenCalledWith(expect.any(Error), candidate);
    expect(repositoryMock.completeEvaluation).not.toHaveBeenCalled();
    expect(repositoryMock.releaseEvaluation).toHaveBeenCalledWith({
      installationId: candidate.installationId,
      owner: "sweep-test",
      retryAt: new Date("2026-08-22T12:00:05.000Z"),
    });
  });
});
