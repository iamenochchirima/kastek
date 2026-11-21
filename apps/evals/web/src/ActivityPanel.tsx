import { useEffect, useRef } from "react";
import type { ProductActivity, ProductActivityEvent, ProductActivityOperation } from "../../shared/types";
import { ErrorBox } from "./components";

function duration(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(1)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

function clock(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const time = date.toLocaleTimeString(undefined, {
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return `${time}.${String(date.getMilliseconds()).padStart(3, "0")}`;
}

function count(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "—";
}

function startTime(operation: ProductActivityOperation): number {
  const value = operation.startedAt ? Date.parse(operation.startedAt) : Number.NaN;
  return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
}

function eventPayload(event: ProductActivityEvent): string {
  const value = JSON.stringify(event.payload ?? {});
  return value.length > 500 ? `${value.slice(0, 500)}…` : value;
}

export function ActivityPanel({ activity, error, live }: {
  activity: ProductActivity | null;
  error: string | null;
  live: boolean;
}) {
  const list = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (live && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [activity, live]);

  const task = activity?.task ?? null;
  const operations = [...(activity?.operations ?? [])].sort((left, right) => startTime(left) - startTime(right));
  const events = activity?.events ?? [];

  return (
    <section className="panel activity-panel">
      <div className="panel-head">
        <div>
          <h2>Activity</h2>
          <p className="muted">Raw operations and timings for the latest turn.</p>
        </div>
        {live ? <span className="activity-live"><span className="activity-pulse" /> Live</span> : null}
      </div>
      {error ? <ErrorBox message={error} /> : null}
      {!task ? (
        <p className="muted small">
          {live ? "Waiting for the first action…" : "Send a message to see the agent's actions."}
        </p>
      ) : (
        <>
          <div className="activity-task">
            <span className="mono">{task.id}</span>
            <span className={`activity-task-state ${task.state}`}>{task.state}</span>
            <span>{duration(task.elapsedMs)} elapsed</span>
            <span>{count(task.modelCalls)} model calls</span>
            <span>{count(task.toolCalls)} tool calls</span>
            <span>{count(task.tokensUsed)} tokens</span>
            {task.errorCode ? <span className="activity-error">{task.errorCode}</span> : null}
          </div>
          <div className="activity-list" ref={list}>
            {operations.length === 0 ? (
              <p className="muted small">{live ? "Waiting for operations…" : "No operations recorded."}</p>
            ) : operations.map((operation, index) => (
              <div
                className={`activity-row ${operation.state}`}
                key={operation.operationId ?? `${task.id}:${index}`}
              >
                <time>{clock(operation.startedAt)}</time>
                <span className="activity-kind">{operation.kind}</span>
                <span className="activity-name" title={operation.operationId}>
                  {operation.label && operation.label !== operation.name
                    ? `${operation.label} · ${operation.name}`
                    : operation.name}
                </span>
                <span className="activity-state">{operation.state}</span>
                <span className="activity-duration">{duration(operation.durationMs)}</span>
                <span className="activity-tokens">
                  {operation.accountedTokens ? `${count(operation.accountedTokens)} tok` : ""}
                </span>
                {operation.errorCode ? <span className="activity-error">{operation.errorCode}</span> : null}
              </div>
            ))}
          </div>
          <details className="activity-events">
            <summary>Raw events · {events.length}</summary>
            <div className="activity-event-list">
              {events.map((event) => (
                <div className="activity-event" key={event.sequence}>
                  <time>{clock(event.createdAt)}</time>
                  <span>{event.kind}</span>
                  <code title={JSON.stringify(event.payload ?? {})}>{eventPayload(event)}</code>
                </div>
              ))}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
