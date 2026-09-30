"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Clock3, Radio, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { streamAgentRun, type AgentOperationEvent } from "@/lib/agent-platform";

const terminalEvents = new Set(["run.completed", "run.failed", "run.cancelled", "run.expired"]);

function formatValue(value: unknown) {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function eventKey(event: AgentOperationEvent, index: number) {
  return String(event.id || event.sequence_number || `${event.event_type || "event"}-${index}`);
}

export function AgentRunLiveTimeline({ runId, initialEvents, terminal }: { runId: string; initialEvents: AgentOperationEvent[]; terminal: boolean }) {
  const router = useRouter();
  const [events, setEvents] = useState(initialEvents);
  const [live, setLive] = useState(!terminal);
  const [error, setError] = useState<string | null>(null);
  const initialSequence = useRef(initialEvents.reduce((latest, event) => Math.max(latest, Number(event.sequence_number) || 0), 0));

  useEffect(() => {
    if (terminal) return;
    const controller = new AbortController();
    void streamAgentRun(runId, (event) => {
      setEvents((current) => {
        const sequence = Number(event.data.sequence_number);
        if (Number.isSafeInteger(sequence) && current.some((entry) => Number(entry.sequence_number) === sequence)) return current;
        return [...current, { ...event.data, event_type: event.event, sequence_number: Number.isSafeInteger(sequence) ? sequence : undefined }];
      });
      if (terminalEvents.has(event.event)) {
        setLive(false);
        router.refresh();
      }
    }, controller.signal, initialSequence.current).catch((cause) => {
      if (controller.signal.aborted) return;
      setLive(false);
      setError(cause instanceof Error ? cause.message : "Live run updates are unavailable");
    });
    return () => controller.abort();
  }, [router, runId, terminal]);

  return <Card><CardContent className="p-6">
    <div className="flex items-center gap-3"><Clock3 className="h-5 w-5 text-primary" /><div><h2 className="text-lg font-semibold text-foreground">Durable timeline</h2><p className="mt-1 text-sm text-muted-foreground">Events are persisted by the Agent Platform and remain available after refresh.</p></div><span className={`ml-auto inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium ${live ? "border-status-info/30 bg-status-info-soft text-status-info" : terminal ? "border-status-success/30 bg-status-success-soft text-status-success" : "border-status-attention/30 bg-status-attention-soft text-status-attention"}`}><Radio className="h-3 w-3" />{live ? "Live" : terminal ? "Complete" : "Paused"}</span></div>
    {error ? <div className="mt-4 flex flex-col gap-3 rounded-lg border border-status-attention/40 bg-status-attention-soft p-3 text-sm text-status-attention sm:flex-row sm:items-center sm:justify-between"><span>{error}</span><Button type="button" size="sm" variant="outline" onClick={() => router.refresh()}><RefreshCw className="mr-1.5 h-3.5 w-3.5" />Refresh</Button></div> : null}
    {events.length === 0 ? <p className="mt-5 text-sm text-muted-foreground">No events have been recorded for this run yet.</p> : <div className="mt-5 space-y-3">{events.map((event, index) => <div key={eventKey(event, index)} className="flex gap-3 rounded-lg border border-border p-3"><div className="mt-0.5 shrink-0 text-muted-foreground"><Clock3 className="h-4 w-4" /></div><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><p className="font-medium text-foreground">{String(event.event_type || "run event").replaceAll(".", " · ")}</p>{event.created_at ? <time className="text-xs text-muted-foreground" dateTime={event.created_at}>{new Date(event.created_at).toLocaleString()}</time> : null}</div>{event.payload ? <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{formatValue(event.payload)}</pre> : null}</div></div>)}</div>}
  </CardContent></Card>;
}
