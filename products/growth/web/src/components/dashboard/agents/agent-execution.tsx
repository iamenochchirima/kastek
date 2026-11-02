import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { AgentExecutionView } from "@kasitek-labs/ui/agent";
import type { GrowthAgentRuntimeOperation, GrowthAgentTask } from "@kasitek-labs/contracts";
import { Button } from "@/components/ui/button";
import { growthAgents, GrowthAgentRequestError } from "@/lib/growth-agents";
import { growthExecution } from "@/lib/growth-agent-presentation";
import { useGrowthAgents } from "./agent-provider";

type History = { key: string; operations: GrowthAgentRuntimeOperation[]; cursor: string | null; loaded: boolean; error: string | null; hidden: boolean; head?: string };
type Props = { task: GrowthAgentTask; onOpenSubagent?: ComponentProps<typeof AgentExecutionView>["onOpenSubagent"]; renderOutput?: ComponentProps<typeof AgentExecutionView>["renderOutput"] };

/** History and live views describe the same immutable native operation identities. */
export function mergeGrowthOperationHistory(taskId:string,history:GrowthAgentRuntimeOperation[],live:GrowthAgentRuntimeOperation[]) {
  const operations=new Map<string,GrowthAgentRuntimeOperation>();
  for(const operation of [...history,...live]) {
    if(operation.taskId!==taskId||operation.kind==="model")continue;
    const previous=operations.get(operation.id);
    if(previous?.completedAt&&!operation.completedAt)continue;
    operations.set(operation.id,operation);
  }
  return [...operations.values()].sort((a,b)=>a.startedAt.localeCompare(b.startedAt)||a.id.localeCompare(b.id));
}

/** Root history uses the same authorized projection as subagent inspection; the provider retains execution ownership. */
export function GrowthExecution({ task, onOpenSubagent, renderOutput }: Props) {
  const { scopeKey, withdrawTask, revokeAccess } = useGrowthAgents();
  const key = `${scopeKey}:${task.id}`;
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const withdrawal = useRef("");
  const [history, setHistory] = useState<History>({ key: "", operations: [], cursor: null, loaded: false, error: null, hidden: false });
  const [busy, setBusy] = useState(false);
  const current = history.key === key ? history : null;
  const unavailable = task.errorCode === "EVIDENCE_UNAVAILABLE";
  const head=task.runtime?.operations.filter(operation=>operation.taskId===task.id&&operation.kind!=="model").at(-1)?.id;
  const latestHead=useRef(head);
  const invalidate = useCallback(() => { ++generation.current; controller.current?.abort(); }, []);
  useEffect(()=>{
    latestHead.current=head;
    setHistory(previous=>previous.key===key&&previous.loaded&&!previous.cursor&&previous.head!==head?{...previous,loaded:false}:previous);
  },[key,head]);

  useEffect(() => {
    ++generation.current; controller.current?.abort(); withdrawal.current = ""; setBusy(false);
    setHistory({ key, operations: [], cursor: null, loaded: false, error: null, hidden: false });
    return invalidate;
  }, [key, invalidate]);
  useEffect(() => {
    if (!unavailable) {
      const clock=task.observedAt??task.updatedAt;
      if(withdrawal.current&&clock>withdrawal.current) {
        withdrawal.current="";
        setHistory(previous=>previous.key===key&&previous.hidden?{key,operations:[],cursor:null,loaded:false,error:null,hidden:false}:previous);
      }
      return;
    }
    withdrawal.current = task.observedAt ?? task.updatedAt;
    ++generation.current; controller.current?.abort(); setBusy(false);
    setHistory({ key, operations: [], cursor: null, loaded: false, error: null, hidden: false });
  }, [key, unavailable, task.observedAt, task.updatedAt]);

  const load = async () => {
    if (busy || unavailable || current?.hidden) return;
    const request = new AbortController(); controller.current = request;
    const revision = generation.current;
    setBusy(true);
    try {
      const result = await growthAgents.activity(task.id, { ...(current?.loaded && current.cursor ? { operationCursor: current.cursor } : {}), limit: 60 }, request.signal);
      if (request.signal.aborted || revision !== generation.current || result.rootTaskId !== task.id || result.task.id !== task.id) return;
      const clock = result.task.observedAt ?? result.task.updatedAt;
      if (clock <= withdrawal.current) return;
      if (result.task.errorCode === "EVIDENCE_UNAVAILABLE") {
        withdrawTask(task.id,clock);
        withdrawal.current = clock; ++generation.current; controller.current?.abort(); setBusy(false);
        setHistory({ key, operations: [], cursor: null, loaded: false, error: "Activity unavailable", hidden: true });
        return;
      }
      if (result.operations.some(operation => operation.taskId !== task.id)) throw new Error("Activity scope changed.");
      setHistory(previous => ({key, operations: mergeGrowthOperationHistory(task.id,previous.key === key ? previous.operations : [],result.operations), cursor: result.nextOperationCursor, loaded: true, error: null, hidden: false, head:latestHead.current}));
    } catch (cause) {
      if (request.signal.aborted || revision !== generation.current) return;
      const hidden = cause instanceof GrowthAgentRequestError && [401, 403, 404].includes(cause.status);
      if(hidden){revokeAccess(cause instanceof Error?cause.message:"Agent access changed.");withdrawal.current=new Date().toISOString();++generation.current;controller.current?.abort();setBusy(false);}
      setHistory(previous => ({ key, operations: hidden ? [] : previous.key === key ? previous.operations : [], cursor: hidden ? null : previous.key === key ? previous.cursor : null,
        loaded: hidden ? false : previous.key === key && previous.loaded, hidden, error: cause instanceof Error ? cause.message : "Unable to load activity." }));
    } finally { if (!request.signal.aborted && revision === generation.current) setBusy(false); }
  };

  const execution = growthExecution(task);
  if (unavailable || current?.hidden) {
    execution.updates = []; execution.operations = []; execution.children = []; execution.output = null; execution.approach = undefined;
    execution.context = undefined; execution.diagnostics = undefined; execution.elapsedMs = undefined; execution.label = "Activity unavailable";
  } else {
    execution.operations = mergeGrowthOperationHistory(task.id,current?.operations??[],task.runtime?.operations??[]).map(operation => ({
      id: operation.id, label: operation.label, state: operation.state, kind: operation.kind, startedAt: operation.startedAt,
      details: `Duration: ${(operation.durationMs / 1000).toFixed(1)} s${operation.errorCode ? ` · ${operation.errorCode}` : ""}`, detailAvailability: "available",
    }));
    execution.output = task.output;
  }
  const hasOlder = !unavailable && !current?.hidden && (current?.loaded ? Boolean(current.cursor) : task.runtime?.operationsTruncated === true);
  return <div className="min-w-0 space-y-2"><AgentExecutionView execution={execution} onOpenSubagent={onOpenSubagent} renderOutput={renderOutput} />
    {hasOlder ? <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>{busy ? "Loading…" : "Load earlier activity"}</Button> : null}
    {current?.error ? <p role="status" className="text-xs text-muted-foreground">{current.error}</p> : null}
  </div>;
}
