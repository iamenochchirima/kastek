"use client";

import Link from "@/lib/link";
import { Activity, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type AgentChatRunEvent = {
  event: string;
  label: string;
};

export function AgentChatRunStatus({
  runId,
  progress,
  events = [],
  running = false,
  className,
}: {
  runId?: string | null;
  progress: string;
  events?: AgentChatRunEvent[];
  running?: boolean;
  className?: string;
}) {
  if (!running && !runId) return null;

  return (
    <div className={cn("shrink-0 border-t border-border px-4 py-2", className)}>
      <div className="mx-auto max-w-3xl rounded-lg border border-border bg-card px-3 py-2 text-xs">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2 text-muted-foreground">
            <Activity className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="truncate">{progress}</span>
            {running ? <LoaderCircle className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" /> : null}
          </div>
          {runId ? <Link href={`/agents/activity/${encodeURIComponent(runId)}`} className="shrink-0 font-medium text-primary hover:underline">View activity</Link> : null}
        </div>
        {events.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Run activity">
            {events.map((entry, index) => (
              <span key={`${entry.event}-${index}`} className={cn("rounded-full px-2 py-0.5 text-[10px]", entry.event.includes("failed") ? "bg-destructive/10 text-destructive" : entry.event.includes("approval") ? "bg-status-attention-soft text-status-attention" : "bg-secondary text-muted-foreground")}>
                {entry.label}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
