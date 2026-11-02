import { useEffect, useRef, useState } from "react";
import { AgentExecutionView, AgentMessage, AgentSubagentModal, type AgentSubagent } from "@kasitek-labs/ui/agent";
import type { GrowthAgentObservation } from "@kasitek-labs/contracts";
import { Button } from "@/components/ui/button";
import { growthAgents, GrowthAgentRequestError, isActiveTask } from "@/lib/growth-agents";
import { assertGrowthObservation, streamGrowthObservation } from "@/lib/growth-agent-stream";
import { growthExecution } from "@/lib/growth-agent-presentation";
import { AgentSources, GrowthAgentMarkdown } from "./agent-content";
import { mergeGrowthOperationHistory } from "./agent-execution";

type Selection = { rootId: string; child: AgentSubagent; scope: string };

export function useGrowthSubagent(scope: string, restoreFocus: () => void) {
  const [stack, setStack] = useState<Selection[]>([]);
  const [observation, setObservation] = useState<GrowthAgentObservation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const triggerScope = useRef<string | null>(null);
  const triggerId = useRef<string | null>(null);
  const generation = useRef(0);
  const observerController = useRef<AbortController | null>(null);
  const withdrawalClock = useRef("");
  const acceptedObservation = useRef<GrowthAgentObservation | null>(null);
  const acceptObservation = useRef<(value: GrowthAgentObservation) => void>(() => {});
  const selected = stack.at(-1);
  const validSelection = selected?.scope === scope ? selected : undefined;
  const selectedId = validSelection?.child.id;
  const rootId = validSelection?.rootId;
  const observationKey = `${scope}:${rootId}:${selectedId}`;
  const [loadedKey, setLoadedKey] = useState("");
  const visible = loadedKey === observationKey ? observation : null;

  useEffect(() => {
    if (!rootId || !selectedId) return;
    const current = ++generation.current;
    const controller = new AbortController();
    observerController.current = controller;
    let timer: ReturnType<typeof setTimeout>;
    const streaming = new AbortController();
    controller.signal.addEventListener("abort", () => streaming.abort(), {once:true});
    let hasLive = false;
    let lastClock = "";
    withdrawalClock.current = "";
    acceptedObservation.current = null;
    setObservation(null); setLoadedKey(observationKey); setError(null); setBusy(true); setReconnecting(false);
    const accept = (value: GrowthAgentObservation) => {
      if (controller.signal.aborted || generation.current !== current) return;
      assertGrowthObservation(value, rootId, selectedId);
      const clock = value.task.observedAt ?? value.task.updatedAt;
      if (clock < lastClock || value.task.errorCode !== "EVIDENCE_UNAVAILABLE" && clock <= withdrawalClock.current) return;
      lastClock = clock;
      if (value.task.errorCode === "EVIDENCE_UNAVAILABLE") { withdrawalClock.current = clock; pagingController.current?.abort(); setPaging(false); setOlder([]); setOlderCursor(null); }
      const previous = acceptedObservation.current;
      if (previous && !isActiveTask(previous.task) && isActiveTask(value.task) && value.task.errorCode !== "EVIDENCE_UNAVAILABLE") value = { ...value, task: { ...value.task, state: previous.task.state, output: previous.task.output } };
      if (value.task.errorCode !== "EVIDENCE_UNAVAILABLE") value = { ...value, operations: mergeGrowthOperationHistory(value.task.id, previous?.operations ?? [], value.operations) };
      acceptedObservation.current = value;
      setObservation(value); setError(null); setBusy(false); setReconnecting(false);
    };
    acceptObservation.current = accept;
    const failed = (cause: unknown, readFailed = false) => {
      if (controller.signal.aborted || generation.current !== current) return;
      if (readFailed) setBusy(false);
      if (cause instanceof GrowthAgentRequestError && [401, 403, 404].includes(cause.status)) {
        ++generation.current; pagingController.current?.abort(); setPaging(false); setOlder([]); setOlderCursor(null); setObservation(null); setError(cause.message); setBusy(false); controller.abort();
      } else { setReconnecting(true); }
    };
    const poll = async () => {
      if (controller.signal.aborted) return;
      try { accept(await growthAgents.activity(rootId, { childTaskId: selectedId }, controller.signal)); }
      catch (cause) { failed(cause, true); }
      if (!controller.signal.aborted) timer = setTimeout(poll, document.visibilityState === "hidden" || hasLive ? 10000 : 2500);
    };
    void poll();
    void streamGrowthObservation(rootId, selectedId, value => { hasLive = true; accept(value); }, cause => { hasLive = false; failed(cause); }, streaming.signal);
    return () => { controller.abort(); streaming?.abort(); clearTimeout(timer); };
  }, [scope, rootId, selectedId, observationKey]);

  const open = (root: string, child: AgentSubagent, button: HTMLButtonElement) => {
    trigger.current = button; triggerScope.current = scope; triggerId.current = child.id; setStack([{ rootId: root, child, scope }]);
  };
  const view = visible ? growthExecution(visible.task) : null;
  const [older, setOlder] = useState<NonNullable<GrowthAgentObservation["operations"]>>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [paging, setPaging] = useState(false);
  const pagingController = useRef<AbortController | null>(null);
  useEffect(() => { setOlder([]); setOlderCursor(undefined); setPaging(false); return () => pagingController.current?.abort(); }, [observationKey]);
  if (view && visible && visible.task.errorCode !== "EVIDENCE_UNAVAILABLE") {
    view.updates = visible.updates;
    const operations = [...older, ...(visible.operations ?? [])].filter(operation => operation.kind !== "model").map(operation => ({...operation,
      details: `Duration: ${(operation.durationMs / 1000).toFixed(1)} s${operation.errorCode ? ` · ${operation.errorCode}` : ""}`, detailAvailability: "available" as const,
    }));
    view.operations = [...new Map([...operations, ...(view.operations ?? [])].map(operation => [operation.id, operation])).values()].sort((a,b) => ("startedAt" in a && "startedAt" in b ? String(a.startedAt).localeCompare(String(b.startedAt)) : 0));
    view.output = visible.task.output;
  }
  const page = async () => {
    const cursor = olderCursor === undefined ? visible?.nextOperationCursor : olderCursor;
    if (!rootId || !selectedId || !cursor || paging) return;
    const controller = new AbortController(); pagingController.current = controller; setPaging(true);
    const current = generation.current;
    try {
      const result = await growthAgents.activity(rootId, { childTaskId: selectedId, operationCursor: cursor }, controller.signal);
      if (controller.signal.aborted || generation.current !== current) return;
      assertGrowthObservation(result, rootId, selectedId);
      if ((result.task.observedAt ?? result.task.updatedAt) <= withdrawalClock.current) return;
      if (!controller.signal.aborted && result.task.errorCode === "EVIDENCE_UNAVAILABLE") acceptObservation.current(result);
      else if (!controller.signal.aborted) { setOlder(previous => mergeGrowthOperationHistory(selectedId, previous, result.operations)); setOlderCursor(result.nextOperationCursor); }
    } catch (cause) { if (!controller.signal.aborted && generation.current === current) { if (cause instanceof GrowthAgentRequestError && [401,403,404].includes(cause.status)) { ++generation.current; observerController.current?.abort(); setObservation(null); setOlder([]); setOlderCursor(null); } setError(cause instanceof Error ? cause.message : "Unable to load activity."); } }
    finally { if (!controller.signal.aborted) setPaging(false); }
  };
  return {
    open,
    dialog: <AgentSubagentModal open={Boolean(validSelection)} onOpenChange={value => { if (!value) setStack([]); }} title={validSelection?.child.name ?? "Agent"}
      assignment={visible?.task.errorCode === "EVIDENCE_UNAVAILABLE" ? undefined : visible?.task.input}
      elapsedMs={visible?.task.runtime?.elapsedMs}
      state={visible?.task.errorCode === "EVIDENCE_UNAVAILABLE" ? "Activity unavailable" : visible?.task.state ?? validSelection?.child.state} viewKey={observationKey} loading={busy && !visible} error={error}
      onBack={stack.length > 1 ? () => setStack(previous => previous.slice(0, -1)) : undefined}
      onCloseAutoFocus={event => { event.preventDefault(); if (triggerScope.current !== scope) return; const replacement = triggerId.current ? document.querySelector<HTMLButtonElement>(`button[data-subagent-id="${CSS.escape(triggerId.current)}"]`) : null; const button = trigger.current?.isConnected ? trigger.current : replacement; if (button) button.focus({ preventScroll: true }); else restoreFocus(); }}>
      {visible ? <>{visible.task.errorCode === "EVIDENCE_UNAVAILABLE" ? <p role="status" className="text-sm text-muted-foreground">Activity unavailable</p> : null}{view ? <AgentExecutionView execution={view} showStatus={false} showContext onOpenSubagent={child => setStack(previous => [...previous, { rootId: rootId!, child, scope }])} renderOutput={text => <AgentMessage role="assistant"><GrowthAgentMarkdown text={text} sources={visible.task.sources} /><AgentSources sources={visible.task.sources ?? []} /></AgentMessage>} /> : null}
        {(olderCursor === undefined ? visible.nextOperationCursor : olderCursor) ? <Button type="button" variant="ghost" size="sm" disabled={paging} onClick={() => void page()}>{paging ? "Loading…" : "Load more activity"}</Button> : null}</> : null}
      {reconnecting ? <p role="status" className="text-xs text-muted-foreground">Reconnecting to activity…</p> : null}
    </AgentSubagentModal>,
  };
}
