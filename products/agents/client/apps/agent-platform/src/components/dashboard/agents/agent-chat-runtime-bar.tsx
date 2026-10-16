"use client";

import { Activity, Gauge } from "lucide-react";
import type { AgentModel, AgentRuntimeTelemetry } from "@/lib/agent-platform";

function displayNumber(value: number | undefined, suffix = "") {
  return value === undefined || !Number.isFinite(value)
    ? "—"
    : `${Math.round(value).toLocaleString()}${suffix}`;
}

function displayDuration(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  if (value < 1_000) return `${Math.round(value)}ms`;
  return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}s`;
}

function displayTimestamp(value: string | undefined) {
  if (!value) return "—";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? "—"
    : timestamp.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
}

export function AgentChatRuntimeBar({
  telemetry,
  model,
  detailsOpen,
  onToggleDetails,
}: {
  telemetry: AgentRuntimeTelemetry | null;
  model?: AgentModel;
  detailsOpen: boolean;
  onToggleDetails: () => void;
}) {
  const contextTokens = telemetry?.context.tokens;
  const contextWindowTokens = telemetry?.context.contextWindowTokens ?? model?.contextWindow;
  const contextValue = contextTokens === undefined && contextWindowTokens === undefined
    ? "—"
    : `${contextTokens?.toLocaleString() ?? "—"} / ${contextWindowTokens?.toLocaleString() ?? "—"}`;
  const utilization = telemetry?.context.utilizationPercent;
  const latency = telemetry?.modelAttempt?.latencyMs ?? telemetry?.rolling.latencyMs;
  const turnElapsed = telemetry?.turn.elapsedMs;

  return (
    <div className="shrink-0 border-b border-border bg-background/60 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
          <Activity className="size-3.5 text-primary" />
          Runtime
        </span>
        <span className="text-muted-foreground">
          Context <strong className="font-medium text-foreground">{contextValue}</strong>
        </span>
        <span className="text-muted-foreground">
          Use <strong className="font-medium text-foreground">{displayNumber(utilization, "%")}</strong>
        </span>
        <span className="text-muted-foreground">
          Latency <strong className="font-medium text-foreground">{displayDuration(latency)}</strong>
        </span>
        <span className="text-muted-foreground">
          Turn <strong className="font-medium text-foreground">{displayDuration(turnElapsed)}</strong>
        </span>
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 text-primary hover:text-primary/80"
          aria-expanded={detailsOpen}
          onClick={onToggleDetails}
        >
          {detailsOpen ? "Hide" : "Details"}
          <span aria-hidden="true">{detailsOpen ? "−" : "+"}</span>
        </button>
      </div>
      {detailsOpen ? (
        telemetry ? (
          <AgentChatRuntimeDetails telemetry={telemetry} />
        ) : (
          <div className="mt-3 border-t border-border pt-3 text-[11px] text-muted-foreground">
            No run data yet.
          </div>
        )
      ) : null}
    </div>
  );
}

export function AgentChatRuntimeDetails({
  telemetry,
}: {
  telemetry: AgentRuntimeTelemetry;
}) {
  const manifest = telemetry.context.manifest;
  const latestCompaction = telemetry.context.latestCompaction;

  return (
    <div className="mt-3 grid gap-2 border-t border-border pt-3 text-[11px] sm:grid-cols-2">
      <div className="rounded-lg border border-border bg-card/70 p-2.5">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <Gauge className="size-3.5 text-primary" />
          Context
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
          <dt>Basis</dt><dd className="text-right text-foreground">{telemetry.context.basis}</dd>
          <dt>Pressure</dt><dd className="text-right text-foreground">{telemetry.context.pressure ?? "—"}</dd>
          <dt>Decision</dt><dd className="text-right text-foreground">{telemetry.context.decision ?? "—"}</dd>
          <dt>Reserve</dt><dd className="text-right text-foreground">{displayNumber(telemetry.context.reservedOutputTokens)}</dd>
          <dt>Safety</dt><dd className="text-right text-foreground">{displayNumber(telemetry.context.safetyMarginTokens)}</dd>
          <dt>Soft / hard</dt><dd className="text-right text-foreground">{displayNumber(telemetry.context.softThresholdTokens)} / {displayNumber(telemetry.context.hardLimitTokens)}</dd>
          <dt>Capability</dt><dd className="truncate text-right text-foreground">{telemetry.context.capabilitySource ?? "—"}</dd>
          <dt>Reason</dt><dd className="truncate text-right text-foreground">{typeof latestCompaction?.reason === "string" ? latestCompaction.reason : telemetry.modelAttempt?.errorCode ?? telemetry.context.decision ?? "—"}</dd>
        </dl>
      </div>
      <div className="rounded-lg border border-border bg-card/70 p-2.5">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <Activity className="size-3.5 text-primary" />
          Model
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
          <dt>Attempt</dt><dd className="text-right text-foreground">{telemetry.modelAttempt?.status ?? "—"}</dd>
          <dt>Model</dt><dd className="truncate text-right text-foreground">{telemetry.modelAttempt?.model ?? "—"}</dd>
          <dt>Queue</dt><dd className="text-right text-foreground">{displayDuration(telemetry.modelAttempt?.queueMs)}</dd>
          <dt>First token</dt><dd className="text-right text-foreground">{displayDuration(telemetry.modelAttempt?.timeToFirstTokenMs)}</dd>
          <dt>Latency</dt><dd className="text-right text-foreground">{displayDuration(telemetry.modelAttempt?.latencyMs)}</dd>
          <dt>Output</dt><dd className="text-right text-foreground">{displayNumber(telemetry.modelAttempt?.outputTokens)} tokens</dd>
          <dt>Attempts</dt><dd className="text-right text-foreground">{telemetry.attempts.length}</dd>
          <dt>Rolling</dt><dd className="text-right text-foreground">{displayDuration(telemetry.rolling.latencyMs)} · {displayNumber(telemetry.rolling.outputTokensPerSecond)} t/s</dd>
        </dl>
      </div>
      <div className="rounded-lg border border-border bg-card/70 p-2.5">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <Gauge className="size-3.5 text-primary" />
          Run usage
        </div>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
          <dt>Total</dt><dd className="text-right text-foreground">{displayNumber(telemetry.usage.totalTokens)} tokens</dd>
          <dt>Input / output</dt><dd className="text-right text-foreground">{displayNumber(telemetry.usage.inputTokens)} / {displayNumber(telemetry.usage.outputTokens)}</dd>
          <dt>Budget</dt><dd className="text-right text-foreground">{displayNumber(telemetry.runBudget.maxTotalTokens)} tokens</dd>
          <dt>Remaining</dt><dd className="text-right text-foreground">{displayNumber(telemetry.runBudget.remainingTokens)} tokens</dd>
          <dt>Basis</dt><dd className="text-right text-foreground">{telemetry.usage.basis}</dd>
        </dl>
      </div>
      <div className="rounded-lg border border-border bg-card/70 p-2.5 sm:col-span-2">
        <div className="flex flex-wrap items-center justify-between gap-2 font-medium text-foreground">
          <span>Evidence</span>
          <span className="font-mono text-[10px] text-muted-foreground">
            rev {telemetry.revision} · {displayTimestamp(telemetry.observedAt)}
          </span>
        </div>
        <dl className="mt-2 grid gap-x-4 gap-y-1 text-muted-foreground sm:grid-cols-2">
          <div className="flex justify-between gap-3"><dt>Manifest</dt><dd className="max-w-[14rem] truncate font-mono text-foreground">{telemetry.context.manifestDigest ?? "—"}</dd></div>
          <div className="flex justify-between gap-3"><dt>Components</dt><dd className="text-foreground">{Array.isArray(manifest?.components) ? manifest.components.length : "—"}</dd></div>
          <div className="flex justify-between gap-3"><dt>Compactions</dt><dd className="text-foreground">{telemetry.context.compactionCount}</dd></div>
          <div className="flex justify-between gap-3"><dt>Latest</dt><dd className="max-w-[14rem] truncate text-foreground">{latestCompaction && typeof latestCompaction.type === "string" ? latestCompaction.type : "—"}</dd></div>
        </dl>
      </div>
    </div>
  );
}
