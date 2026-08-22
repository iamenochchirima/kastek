import { randomUUID } from "node:crypto";
import type { ReadinessEvaluationCandidate, ReadinessRepository } from "../db/repositories/readiness-repository";

export interface ReadinessSweepSettings {
  intervalMs: number;
  batchSize: number;
  leaseDurationMs: number;
  retryDelayMs?: number;
  owner?: string;
  evaluate: (candidate: ReadinessEvaluationCandidate) => Promise<void>;
  onError?: (error: unknown, candidate?: ReadinessEvaluationCandidate) => void;
}

/**
 * Runs bounded readiness evaluations without making any API replica the sole
 * owner of the work. PostgreSQL leases provide the coordination boundary; the
 * immutable Analytics outbox remains the only durable observation sink.
 */
export class ReadinessSweep {
  private readonly owner: string;
  private readonly retryDelayMs: number;
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private stopped = false;

  public constructor(
    private readonly repository: ReadinessRepository,
    private readonly settings: ReadinessSweepSettings,
  ) {
    this.owner = settings.owner ?? `agent-readiness-sweep:${randomUUID()}`;
    this.retryDelayMs = settings.retryDelayMs ?? Math.min(settings.intervalMs, 30_000);
    if (!Number.isSafeInteger(settings.intervalMs) || settings.intervalMs < 30_000) throw new Error("Readiness sweep interval is invalid");
    if (!Number.isSafeInteger(settings.batchSize) || settings.batchSize < 1) throw new Error("Readiness sweep batch size is invalid");
    if (!Number.isSafeInteger(settings.leaseDurationMs) || settings.leaseDurationMs < settings.intervalMs) throw new Error("Readiness sweep lease is invalid");
  }

  public start(): void {
    if (this.timer || this.stopped) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.settings.intervalMs);
    this.timer.unref();
  }

  public async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    while (this.running) await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }

  public async runOnce(now = new Date()): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    try {
      const candidates = await this.repository.claimDueEvaluations({
        owner: this.owner,
        limit: this.settings.batchSize,
        leaseDurationMs: this.settings.leaseDurationMs,
        now,
      });
      await Promise.all(candidates.map((candidate) => this.evaluate(candidate, now)));
    } catch (error) {
      this.settings.onError?.(error);
    } finally {
      this.running = false;
    }
  }

  private async evaluate(candidate: ReadinessEvaluationCandidate, now: Date): Promise<void> {
    try {
      await this.settings.evaluate(candidate);
      await this.repository.completeEvaluation({
        installationId: candidate.installationId,
        owner: this.owner,
        evaluatedAt: now,
        nextEvaluationAt: new Date(now.getTime() + this.settings.intervalMs),
      });
    } catch (error) {
      this.settings.onError?.(error, candidate);
      await this.repository.releaseEvaluation({
        installationId: candidate.installationId,
        owner: this.owner,
        retryAt: new Date(now.getTime() + this.retryDelayMs),
      }).catch((releaseError) => this.settings.onError?.(releaseError, candidate));
    }
  }
}
