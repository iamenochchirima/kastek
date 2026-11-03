import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft, Brain, Plus, Square } from "lucide-react";
import type { AgencyAgentCommandInputs, AgencyAgentConversation, AgencyAgentHistory, AgencyAgentObservation, AgencyAgentOperation, AgencyAgentTask, GrowthAgentMessage } from "@kasitek-labs/contracts";
import { AgentComposer, AgentContextUsage, AgentConversationScroll, AgentExecutionView, AgentMessage, AgentResultFiles, AgentSubagentModal, agentIsActive, agentRuntimePresentation, type AgentExecution, type AgentSubagent } from "@kasitek-labs/ui/agent";
import { AgentMemoryPanel, type AgentMemoryPage } from "@kasitek-labs/ui/agent-memory";
import { Button } from "@/components/ui/button";
import { Layout } from "@/components/layout";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ProtectedRoute, useAuth } from "@/lib/auth";
import { AGENT_ROLES } from "@/lib/tenant-access";
import { tenantDownload, tenantFetch, TenantApiError } from "@/lib/api";

interface Readiness { ready: boolean; code?: string; memoryEnabled: boolean; revision: number; canConfigureModel?: boolean; client?:{id:string;name:string};model: { label: string; modelId: string } | null }
interface AgencyConversationPage { conversations: AgencyAgentConversation[]; nextCursor: string | null }
const revalidateMs=5000;
function redactedObservation(value:AgencyAgentObservation):AgencyAgentObservation{
  const task=value.task;
  return {task:{id:task.id,conversationId:task.conversationId,featureId:task.featureId,state:task.state,
    input:"",output:null,errorCode:"EVIDENCE_UNAVAILABLE",createdAt:task.createdAt,updatedAt:task.updatedAt,
    canSteer:false,canContinue:false,sources:[],children:[],updates:[]},rootTaskId:value.rootTaskId,parentTaskId:value.parentTaskId,
    agentName:"Agent",operations:[],updates:[],events:[],nextCursor:null,nextOperationCursor:null,updatesTruncated:false};
}
function redactAgentQueries(cache:QueryClient,keys:readonly unknown[]){
  for(const [key,value] of cache.getQueriesData({queryKey:keys})){
    if(!value||typeof value!=="object")continue;
    const kind=key[keys.length];
    if(kind==="history"){
      const history=value as AgencyAgentHistory;
      cache.setQueryData(key,{...history,conversation:{...history.conversation,title:""},messages:[],tasks:[]},{updatedAt:0});
    }
    if(kind==="conversations")cache.setQueryData(key,{...(value as object),conversations:[]},{updatedAt:0});
    if(kind==="readiness")cache.setQueryData(key,{...(value as Readiness),ready:false,client:undefined,model:null},{updatedAt:0});
    if(kind==="observation"){
      cache.setQueryData(key,redactedObservation(value as AgencyAgentObservation),{updatedAt:0});
    }
  }
}
function execution(task: AgencyAgentTask, observation?: AgencyAgentObservation): AgentExecution {
  return { ...agentRuntimePresentation(task.runtime),id: task.id, state: task.state,errorCode:task.errorCode, output: task.output, updates: observation?.updates ?? task.updates,
    children: task.children, elapsedMs: task.runtime?.elapsedMs, observedAt: task.observedAt,
    context: task.runtime?.context, operations: (observation?.operations ?? task.runtime?.operations ?? []).map(operation => ({
      id: operation.id, taskId: operation.taskId, category: operation.category, source: operation.source, activityKind: operation.activityKind, technicalName: operation.technicalName, kind: operation.kind, label: operation.label, state: operation.state, startedAt: operation.startedAt,
      durationMs:operation.durationMs,errorCode:operation.errorCode,
    })) };
}
function mergeOperations(...pages: AgencyAgentObservation["operations"][]): AgencyAgentObservation["operations"] {
  return [...new Map(pages.flat().map(operation => [operation.id, operation])).values()]
    .sort((left, right) => left.startedAt.localeCompare(right.startedAt) || left.id.localeCompare(right.id));
}
function AgencyActivity({ task, observation, rootTaskId = task.id, childTaskId, read, onUnavailable, onOpenSubagent, showStatus = true }: {
  task: AgencyAgentTask; observation?: AgencyAgentObservation; rootTaskId?: string; childTaskId?: string;
  read(input: AgencyAgentCommandInputs["tasks.observe"], signal: AbortSignal): Promise<AgencyAgentObservation>;
  onUnavailable(): void; onOpenSubagent(item: AgentSubagent, button: HTMLButtonElement): void; showStatus?: boolean;
}) {
  const [retained, setRetained] = useState<AgencyAgentObservation["operations"]>([]);
  const [history, setHistory] = useState<{ operations: AgencyAgentObservation["operations"]; next: string | null } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  const unavailable = task.errorCode === "EVIDENCE_UNAVAILABLE";
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (unavailable) { request.current?.abort(); request.current = null; setRetained([]); setHistory(null); setBusy(false); return; }
    if (observation) setRetained(previous => mergeOperations(previous, observation.operations));
  }, [observation, unavailable]);
  const next = history ? history.next : observation?.nextOperationCursor;
  async function earlier() {
    if (busy || request.current || unavailable || next === null) return;
    const controller = new AbortController(); request.current = controller; setBusy(true); setError(null);
    try {
      const value = await read({ taskId: rootTaskId, ...(childTaskId ? { childTaskId } : {}), ...(next ? { operationCursor: next } : {}) }, controller.signal);
      if (controller.signal.aborted) return;
      if (value.rootTaskId !== rootTaskId || value.task.id !== task.id || value.task.errorCode === "EVIDENCE_UNAVAILABLE") { setRetained([]); setHistory(null); onUnavailable(); return; }
      setHistory(previous => ({ operations: mergeOperations(previous?.operations ?? [], value.operations), next: value.nextOperationCursor }));
    } catch (failure) {
      if (!controller.signal.aborted) {
        setError(failure instanceof Error ? failure.message : "Activity unavailable");
        if (failure instanceof TenantApiError && [401, 403, 404].includes(failure.status)) { setRetained([]); setHistory(null); onUnavailable(); }
      }
    } finally { if (request.current === controller) { request.current = null; if (!controller.signal.aborted) setBusy(false); } }
  }
  const view = execution(task, observation);
  view.operations = unavailable ? [] : mergeOperations(history?.operations ?? [], retained, observation?.operations ?? task.runtime?.operations ?? []).map(operation => ({
    id: operation.id, taskId: operation.taskId, category: operation.category, source: operation.source, activityKind: operation.activityKind, technicalName: operation.technicalName, kind: operation.kind, label: operation.label, state: operation.state, startedAt: operation.startedAt,
    durationMs: operation.durationMs, errorCode: operation.errorCode,
  }));
  return <AgentExecutionView execution={view} onOpenSubagent={onOpenSubagent} showContext showStatus={showStatus}>
    {!unavailable && next !== null ? <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => void earlier()}>{busy ? "Loading…" : "Earlier activity"}</Button> : null}
    {error ? <p role="alert" className="text-xs text-destructive">{error}</p> : null}
  </AgentExecutionView>;
}
function TaskResults({ task, base, rootTaskId = task.id, childTaskId }: { task: AgencyAgentTask; base: string; rootTaskId?: string; childTaskId?: string }) {
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState<string | null>(null);
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const results = task.results?.filter(result => result.kind === "artifact" && result.artifactId) ?? [];
  async function download(artifactId: string, title: string) {
    if (request.current) return;
    const controller = new AbortController();request.current = controller;setBusy(artifactId);setError(null);
    try {
      const selection=childTaskId?`?${new URLSearchParams({childTaskId})}`:"";
      const content = await tenantDownload(`${base}/tasks/${encodeURIComponent(rootTaskId)}/artifacts/${encodeURIComponent(artifactId)}/download${selection}`, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(content), link = document.createElement("a");
      link.href = url;link.download = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(title) ? title : "agent-result";
      document.body.append(link);link.click();link.remove();window.setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : "Download unavailable");
    } finally {
      if (request.current === controller) { request.current = null;if (!controller.signal.aborted) setBusy(null); }
    }
  }
  return <AgentResultFiles files={results.map(result=>({id:result.artifactId!,title:result.title}))} busyId={busy} error={error} onSelect={file=>void download(file.id,file.title)} />;
}
export default function ClientAgentScreen({ clientId }: { clientId: string }) {
  const {user}=useAuth();
  return <ProtectedRoute allowedRoles={AGENT_ROLES}><Layout><ClientAgent key={`${user?.workspaceId}:${user?.id}:${clientId}`} clientId={clientId} /></Layout></ProtectedRoute>;
}
function ClientAgent({ clientId }: { clientId: string }) {
  const { user } = useAuth(), cache = useQueryClient(), [parameters, setParameters] = useSearchParams();
  const base = `/api/clients/${encodeURIComponent(clientId)}/agent`, scope = `${user?.workspaceId}:${user?.id}:${clientId}`;
  const keys = useMemo(() => ["agency-agent", scope], [scope]);
  const [input, setInput] = useState(""), [sending, setSending] = useState(false), [error, setError] = useState<string | null>(null);
  const [accessError,setAccessError]=useState<string|null>(null),visibilityEpoch=useRef(0),invalidatedAt=useRef(0);
  const [paginationDenied,setPaginationDenied]=useState(false);
  const [memoryOpen, setMemoryOpen] = useState(false), [accepted, setAccepted] = useState<AgencyAgentTask | null>(null);
  const [queued,setQueued]=useState<GrowthAgentMessage[]>([]);
  const [olderConversations,setOlderConversations]=useState<AgencyConversationPage[]>([]);
  const [olderConversationsBusy,setOlderConversationsBusy]=useState(false),[olderConversationsError,setOlderConversationsError]=useState<string|null>(null);
  const [olderHistory,setOlderHistory]=useState<{conversationId:string|null;pages:AgencyAgentHistory[]}>({conversationId:null,pages:[]});
  const [olderHistoryBusy,setOlderHistoryBusy]=useState(false),[olderHistoryError,setOlderHistoryError]=useState<string|null>(null);
  const [modelOpen,setModelOpen]=useState(false),[providerId,setProviderId]=useState(""),[modelId,setModelId]=useState(""),[apiKey,setApiKey]=useState("");
  const [modelBusy,setModelBusy]=useState(false),[modelError,setModelError]=useState<string|null>(null);
  const modelRequest=useRef<{signature:string;id:string}|null>(null);
  const [continuing, setContinuing] = useState(false), continueRequest = useRef<{taskId:string;id:string}|null>(null), continueBusy = useRef(false);
  const [childPath, setChildPath] = useState<AgentSubagent[]>([]), trigger = useRef<HTMLButtonElement | null>(null);
  const [childRootId,setChildRootId]=useState<string|null>(null),composer=useRef<HTMLTextAreaElement|null>(null);
  const conversationsPageRequest=useRef<AbortController|null>(null),historyPageRequest=useRef<AbortController|null>(null),settledRefreshTaskId=useRef<string|null>(null);
  const pending = useRef<{ signature: string; requestId: string; createRequestId: string; conversationId?: string } | null>(null), currentScope = useRef(scope); currentScope.current = scope;
  const conversationId = parameters.get("conversation");
  const currentConversation = useRef(conversationId); currentConversation.current=conversationId;
  const command = useCallback(<K extends AgencyAgentOperation>(operation: K, input: AgencyAgentCommandInputs[K], requestId: string = crypto.randomUUID(), signal?: AbortSignal) =>
    tenantFetch<unknown>(`${base}/commands`, { method: "POST", signal, body: JSON.stringify({ operation, input, requestId }) }), [base]);
  const readiness = useQuery({ queryKey: [...keys, "readiness"], queryFn: ({ signal }) => tenantFetch<Readiness>(base, { signal }),retry:false,refetchInterval:revalidateMs,refetchIntervalInBackground:false });
  const providers=useQuery({queryKey:[...keys,"providers"],queryFn:({signal})=>command("models.providers",{},undefined,signal) as Promise<{providers:{id:string;name:string}[]}>,enabled:modelOpen&&!!readiness.data?.canConfigureModel});
  const conversations = useQuery({ queryKey: [...keys, "conversations"], queryFn: ({ signal }) => command("conversations.list", {limit:20}, undefined, signal) as Promise<AgencyConversationPage>, enabled: readiness.isSuccess,retry:false,
    refetchInterval:olderConversations.length?false:revalidateMs,refetchOnWindowFocus:olderConversations.length===0,refetchIntervalInBackground:false });
  const history = useQuery({ queryKey: [...keys, "history", conversationId], queryFn: ({ signal }) => command("conversations.get", { conversationId: conversationId!, limit: 20 }, undefined, signal) as Promise<AgencyAgentHistory>, enabled: readiness.isSuccess && !!conversationId,retry:false,
    refetchInterval:olderHistory.conversationId===conversationId&&olderHistory.pages.length?false:revalidateMs,
    refetchOnWindowFocus:!(olderHistory.conversationId===conversationId&&olderHistory.pages.length>0),refetchIntervalInBackground:false });
  const latestTaskId = accepted?.conversationId === conversationId ? accepted.id : history.data?.tasks?.at(-1)?.id;
  const root = useQuery({ queryKey: [...keys, "observation", latestTaskId], queryFn: ({ signal }) => command("tasks.observe", { taskId: latestTaskId! }, undefined, signal) as Promise<AgencyAgentObservation>, enabled: !!latestTaskId && readiness.isSuccess,
    retry:false,refetchIntervalInBackground:false,refetchInterval: query => query.state.data && agentIsActive(query.state.data.task.state) ? 1000 : revalidateMs });
  const child = childPath.at(-1);
  const conversationItems = useMemo(() => {
    const seen=new Set<string>();
    return [...(conversations.data?.conversations??[]),...olderConversations.flatMap(page=>page.conversations)].filter(item=>{
      if(seen.has(item.id))return false;
      seen.add(item.id);return true;
    });
  },[conversations.data,olderConversations]);
  const conversationCursor=olderConversations.length?olderConversations.at(-1)!.nextCursor:conversations.data?.nextCursor??null;
  const olderHistoryPages=olderHistory.conversationId===conversationId?olderHistory.pages:[];
  const historyPages=useMemo(()=>[...olderHistoryPages].reverse().concat(history.data?[history.data]:[]),[olderHistoryPages,history.data]);
  const historyMessages=useMemo(()=>historyPages.flatMap(page=>page.messages),[historyPages]);
  const historyCursor=olderHistoryPages.length?olderHistoryPages.at(-1)!.nextCursor:history.data?.nextCursor??null;
  const inspected = useQuery({ queryKey: [...keys, "observation", childRootId, child?.id], queryFn: ({ signal }) => command("tasks.observe", { taskId: childRootId!, childTaskId: child!.id }, undefined, signal) as Promise<AgencyAgentObservation>, enabled: !!childRootId && !!child,
    retry:false,refetchIntervalInBackground:false,refetchInterval: query => query.state.data && agentIsActive(query.state.data.task.state) ? 1000 : revalidateMs });
  const active = root.data?.task && !root.error ? root.data.task : accepted?.conversationId === conversationId ? accepted : null;
  const working = !!active && agentIsActive(active.state);
  const canSteer = working && active?.canSteer === true && active.state !== "cancel_requested";
  const blocked = !!(working && !canSteer);
  const turns = useMemo(() => {
    const values = new Map<string,AgencyAgentTask>();
    for(const page of historyPages)for(const task of page.tasks)values.set(task.id,task);
    if (accepted?.conversationId === conversationId) values.set(accepted.id, accepted);
    if (root.data && !root.error) values.set(root.data.task.id, root.data.task);
    return [...values.values()].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id.localeCompare(right.id));
  }, [accepted, conversationId, historyPages, root.data, root.error]);
  const authorityError=readiness.error||history.error||root.error||conversations.error||paginationDenied||root.dataUpdatedAt>0&&root.data?.task.errorCode==="EVIDENCE_UNAVAILABLE"?"Conversation unavailable":null;
  const hidden = !!accessError || !!authorityError;
  const inspectedUnavailable=hidden||!!inspected.error||inspected.data?.task.errorCode==="EVIDENCE_UNAVAILABLE"||
    !!inspected.data&&(inspected.data.rootTaskId!==childRootId||inspected.data.task.id!==child?.id);
  const refreshConversations=useCallback(()=>{
    conversationsPageRequest.current?.abort();conversationsPageRequest.current=null;setOlderConversations([]);setOlderConversationsBusy(false);setOlderConversationsError(null);
    void cache.invalidateQueries({queryKey:[...keys,"conversations"],exact:true});
  },[cache,keys]);
  const refreshHistory=useCallback(()=>{
    historyPageRequest.current?.abort();historyPageRequest.current=null;setOlderHistory({conversationId,pages:[]});setOlderHistoryBusy(false);setOlderHistoryError(null);
    if(conversationId)void cache.invalidateQueries({queryKey:[...keys,"history",conversationId],exact:true});
  },[cache,keys,conversationId]);
  useEffect(() => {
    visibilityEpoch.current++;invalidatedAt.current=0;settledRefreshTaskId.current=null;setAccessError(null);setPaginationDenied(false);setChildPath([]);setChildRootId(null);setAccepted(null);setQueued([]);setError(null);pending.current=null;continueRequest.current=null;continueBusy.current=false;setContinuing(false);
    historyPageRequest.current?.abort();historyPageRequest.current=null;setOlderHistory({conversationId,pages:[]});setOlderHistoryBusy(false);setOlderHistoryError(null);
  }, [conversationId, scope]);
  useEffect(()=>()=>{conversationsPageRequest.current?.abort();historyPageRequest.current?.abort();},[]);
  useEffect(()=>{
    if(!authorityError)return;
    const epoch=++visibilityEpoch.current;invalidatedAt.current=Date.now();setAccessError(authorityError);
    setAccepted(null);setQueued([]);setSending(false);setMemoryOpen(false);setModelOpen(false);setApiKey("");pending.current=null;modelRequest.current=null;continueRequest.current=null;continueBusy.current=false;setContinuing(false);
    conversationsPageRequest.current?.abort();conversationsPageRequest.current=null;historyPageRequest.current?.abort();historyPageRequest.current=null;
    setOlderConversations([]);setOlderConversationsBusy(false);setOlderConversationsError(null);setOlderHistory({conversationId:null,pages:[]});setOlderHistoryBusy(false);setOlderHistoryError(null);
    void cache.cancelQueries({queryKey:keys}).then(()=>{if(visibilityEpoch.current===epoch)redactAgentQueries(cache,keys);});
  },[authorityError,readiness.errorUpdatedAt,history.errorUpdatedAt,root.errorUpdatedAt,conversations.errorUpdatedAt,root.data?.task.errorCode,cache,keys]);
  useEffect(()=>{
    const fence=invalidatedAt.current;
    const fresh=readiness.isSuccess&&readiness.dataUpdatedAt>fence&&
      (!conversationId||history.isSuccess&&history.dataUpdatedAt>fence)&&
      (!latestTaskId||root.isSuccess&&root.dataUpdatedAt>fence);
    if(!accessError||!fresh)return;
    if(paginationDenied){setPaginationDenied(false);return;}
    if(!authorityError)setAccessError(null);
  },[accessError,authorityError,paginationDenied,readiness.isSuccess,readiness.dataUpdatedAt,conversationId,history.isSuccess,history.dataUpdatedAt,latestTaskId,root.isSuccess,root.dataUpdatedAt]);
  useEffect(()=>{
    if(!child||!childRootId||!inspected.error&&!(inspected.dataUpdatedAt>0&&inspected.data?.task.errorCode==="EVIDENCE_UNAVAILABLE"))return;
    const key=[...keys,"observation",childRootId,child.id];
    void cache.cancelQueries({queryKey:key,exact:true}).then(()=>cache.setQueryData<AgencyAgentObservation>(key,
      value=>value?redactedObservation(value):value,{updatedAt:0}));
  },[child?.id,childRootId,inspected.errorUpdatedAt,inspected.data?.task.errorCode,cache,keys]);
  useEffect(() => {
    const task=root.data?.task;
    if(!task||agentIsActive(task.state)||settledRefreshTaskId.current===task.id)return;
    settledRefreshTaskId.current=task.id;
    const earlierHistoryLoaded=olderHistory.conversationId===conversationId&&olderHistory.pages.length>0;
    if(!historyPageRequest.current&&!earlierHistoryLoaded)refreshHistory();
    if(!conversationsPageRequest.current&&!olderConversations.length)refreshConversations();
  },[root.data?.task.state,root.data?.task.id,conversationId,olderHistory.conversationId,olderHistory.pages.length,olderConversations.length,refreshHistory,refreshConversations]);
  async function loadOlderConversations(){
    const cursor=conversationCursor;
    if(!cursor||hidden||conversationsPageRequest.current)return;
    const expectedScope=scope,controller=new AbortController();conversationsPageRequest.current=controller;setOlderConversationsBusy(true);setOlderConversationsError(null);
    try{
      const result=await command("conversations.list",{cursor,limit:20},undefined,controller.signal) as AgencyConversationPage;
      if(controller.signal.aborted||currentScope.current!==expectedScope)return;
      setOlderConversations(previous=>[...previous,result]);
    }catch(failure){
      if(controller.signal.aborted||currentScope.current!==expectedScope)return;
      if(failure instanceof TenantApiError&&[401,403,404].includes(failure.status)){setPaginationDenied(true);return;}
      setOlderConversationsError("Couldn't load older conversations.");
    }finally{
      if(conversationsPageRequest.current===controller){conversationsPageRequest.current=null;if(!controller.signal.aborted)setOlderConversationsBusy(false);}
    }
  }
  async function loadOlderHistory(){
    const cursor=historyCursor,expectedConversation=conversationId;
    if(!cursor||!expectedConversation||hidden||historyPageRequest.current)return;
    const expectedScope=scope,controller=new AbortController();historyPageRequest.current=controller;setOlderHistoryBusy(true);setOlderHistoryError(null);
    try{
      const result=await command("conversations.get",{conversationId:expectedConversation,cursor,limit:20},undefined,controller.signal) as AgencyAgentHistory;
      if(controller.signal.aborted||currentScope.current!==expectedScope||currentConversation.current!==expectedConversation)return;
      setOlderHistory(previous=>({conversationId:expectedConversation,pages:previous.conversationId===expectedConversation?[...previous.pages,result]:[result]}));
    }catch(failure){
      if(controller.signal.aborted||currentScope.current!==expectedScope||currentConversation.current!==expectedConversation)return;
      if(failure instanceof TenantApiError&&[401,403,404].includes(failure.status)){setPaginationDenied(true);return;}
      setOlderHistoryError("Couldn't load earlier messages.");
    }finally{
      if(historyPageRequest.current===controller){historyPageRequest.current=null;if(!controller.signal.aborted)setOlderHistoryBusy(false);}
    }
  }
  async function submit() {
    if (!input.trim() || sending || continueBusy.current || blocked || !readiness.data?.ready || hidden) return;
    const text = input, expectedScope = scope, epoch=visibilityEpoch.current,signature = JSON.stringify({ scope, conversationId, text, taskId: working ? active?.id : null });
    if (pending.current?.signature !== signature) pending.current = { signature, requestId: crypto.randomUUID(), createRequestId: crypto.randomUUID() };
    setSending(true); setError(null);
    try {
      if (working && active) {
        const result=await command("tasks.instructions", { taskId: active.id, instruction: text }, pending.current.requestId) as {message:GrowthAgentMessage};
        if (currentScope.current === expectedScope&&visibilityEpoch.current===epoch) { setQueued(previous=>[...new Map([...previous,result.message].map(message=>[message.id,message])).values()]);setInput(""); pending.current = null;refreshHistory(); }
        return;
      }
      let id = conversationId ?? pending.current.conversationId;
      if (!id) {
        const created = await command("conversations.create", {}, pending.current.createRequestId) as { conversation: AgencyAgentConversation };
        id = created.conversation.id;
        pending.current.conversationId = id;
      }
      const result = await command("turns.submit", { conversationId: id, text }, pending.current.requestId) as { task: AgencyAgentTask };
      if (currentScope.current !== expectedScope||visibilityEpoch.current!==epoch) return;
      setParameters({ conversation: id }); setAccepted(result.task); setInput(""); pending.current = null;
      if(id===conversationId)refreshHistory();
      refreshConversations();
    } catch (failure) { if (currentScope.current === expectedScope&&visibilityEpoch.current===epoch) setError(failure instanceof Error ? failure.message : "Message could not be sent"); }
    finally { if (currentScope.current === expectedScope&&visibilityEpoch.current===epoch) setSending(false); }
  }
  async function continueTask() {
    if (!active?.canContinue || continueBusy.current || sending || hidden || !readiness.data?.ready) return;
    const taskId = active.id, expectedScope = scope, expectedConversation = conversationId, epoch = visibilityEpoch.current;
    if (continueRequest.current?.taskId !== taskId) continueRequest.current = { taskId, id: crypto.randomUUID() };
    continueBusy.current = true; setContinuing(true); setError(null);
    try {
      const result = await command("tasks.continue", { taskId }, continueRequest.current.id) as { accepted: true; taskId: string };
      if (currentScope.current !== expectedScope || currentConversation.current !== expectedConversation || visibilityEpoch.current !== epoch) return;
      const value = await command("tasks.observe", { taskId: result.taskId }) as AgencyAgentObservation;
      if (currentScope.current !== expectedScope || currentConversation.current !== expectedConversation || visibilityEpoch.current !== epoch) return;
      if (value.rootTaskId !== result.taskId || value.task.id !== result.taskId) throw new Error("Activity unavailable");
      cache.setQueryData([...keys, "observation", result.taskId], value); setAccepted(value.task); continueRequest.current = null;
      refreshHistory();
    } catch (failure) {
      if (currentScope.current === expectedScope && currentConversation.current === expectedConversation && visibilityEpoch.current === epoch) setError(failure instanceof Error ? failure.message : "Could not continue work");
    } finally {
      if (currentScope.current === expectedScope && currentConversation.current === expectedConversation && visibilityEpoch.current === epoch) { continueBusy.current = false; setContinuing(false); }
    }
  }
  const readActivity = (input: AgencyAgentCommandInputs["tasks.observe"], signal: AbortSignal) => command("tasks.observe", input, undefined, signal) as Promise<AgencyAgentObservation>;
  const openChild = (item: AgentSubagent, button: HTMLButtonElement,rootId:string) => { if (!childPath.length) trigger.current = button;setChildRootId(rootId); setChildPath(previous => [...previous, item]); };
  async function configureModel(){
    if(modelBusy||!providerId||!modelId.trim()||!apiKey.trim())return;
    const expectedScope=scope,epoch=visibilityEpoch.current,signature=JSON.stringify({scope,providerId,modelId,apiKey});
    if(modelRequest.current?.signature!==signature)modelRequest.current={signature,id:crypto.randomUUID()};
    setModelBusy(true);setModelError(null);
    try{
      const result=await tenantFetch<Readiness>(`${base}/model`,{method:"POST",body:JSON.stringify({requestId:modelRequest.current.id,providerId,modelId:modelId.trim(),apiKey})});
      if(currentScope.current!==expectedScope||visibilityEpoch.current!==epoch)return;
      cache.setQueryData<Readiness>([...keys,"readiness"],previous=>({...previous,...result,canConfigureModel:previous?.canConfigureModel}));
      if(!result.ready){setModelError(result.code??"Model setup incomplete");return;}
      setApiKey("");setModelOpen(false);modelRequest.current=null;
    }catch(failure){if(currentScope.current===expectedScope&&visibilityEpoch.current===epoch)setModelError(failure instanceof Error?failure.message:"Model could not be configured");}
    finally{if(currentScope.current===expectedScope&&visibilityEpoch.current===epoch)setModelBusy(false);}
  }
  return <div className="flex h-[calc(100dvh-4rem)] min-h-96 min-w-0 flex-col">
    <header className="flex min-h-16 shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-6"><div className="flex min-w-0 items-center gap-3"><Button variant="ghost" size="icon" asChild><Link to={`/clients/${clientId}`} aria-label="Back to client"><ArrowLeft /></Link></Button><div className="min-w-0"><h1 className="text-lg font-semibold">Assistant</h1><p className="truncate text-xs text-muted-foreground">{hidden?undefined:readiness.data?.client?.name}</p></div></div><div className="flex items-center gap-2"><Button variant="ghost" size="sm" aria-label="Memory" onClick={() => setMemoryOpen(true)} disabled={hidden||!readiness.data}><Brain className="size-4" /><span className="hidden sm:inline">Memory</span></Button><Button variant="outline" size="sm" onClick={() => setParameters({})} disabled={hidden||sending}><Plus className="size-4" />New chat</Button></div></header>
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <nav aria-label="Agent conversations" className="shrink-0 border-b p-3 md:w-56 md:overflow-auto md:border-r md:border-b-0">
        <label htmlFor="agency-agent-conversation" className="sr-only">Conversation</label>
        <select id="agency-agent-conversation" aria-label="Conversation" value={conversationId ?? ""} onChange={event => setParameters(event.target.value ? { conversation: event.target.value } : {})} className="min-h-10 w-full rounded-lg border bg-background px-3 text-sm md:hidden">
          <option value="">New chat</option>{(hidden?[]:conversationItems).map(value => <option key={value.id} value={value.id}>{value.title}</option>)}
        </select>
        <div className="hidden space-y-1 md:block">{(hidden?[]:conversationItems).map(value => <button type="button" key={value.id} onClick={() => setParameters({ conversation: value.id })} aria-current={value.id === conversationId ? "page" : undefined} className={`min-h-11 w-full truncate rounded-lg px-3 text-left text-sm hover:bg-secondary ${value.id === conversationId ? "bg-secondary font-medium" : ""}`}>{value.title}</button>)}</div>
        {!hidden&&conversationCursor?<Button variant="ghost" size="sm" className="mt-2 w-full justify-start" onClick={()=>void loadOlderConversations()} disabled={olderConversationsBusy||!!olderConversationsError}>{olderConversationsBusy?"Loading…":"Older conversations"}</Button>:null}
        {!hidden&&olderConversations.length&&!olderConversationsError?<Button variant="ghost" size="sm" className="w-full justify-start" onClick={refreshConversations} disabled={olderConversationsBusy}>Refresh conversations</Button>:null}
        {!hidden&&olderConversationsError?<div role="alert" className="mt-2 space-y-2 text-xs text-destructive"><p>{olderConversationsError}</p><Button variant="outline" size="sm" onClick={refreshConversations}>Refresh conversations</Button></div>:null}
      </nav>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <AgentConversationScroll resetKey={`${scope}:${conversationId ?? "new"}`}>
          {readiness.isPending || conversationId && history.isPending ? <div role="status" aria-label="Loading conversation" className="space-y-5"><Skeleton className="ml-auto h-16 w-2/3" /><Skeleton className="h-32 w-5/6" /></div> : null}
          {!hidden&&(historyCursor||olderHistoryPages.length)?<div className="flex flex-wrap justify-center gap-2 py-2">
            {historyCursor?<Button variant="outline" size="sm" onClick={()=>void loadOlderHistory()} disabled={olderHistoryBusy||!!olderHistoryError}>{olderHistoryBusy?"Loading…":"Earlier messages"}</Button>:null}
            {olderHistoryPages.length&&!olderHistoryError?<Button variant="ghost" size="sm" onClick={refreshHistory} disabled={olderHistoryBusy}>Refresh history</Button>:null}
          </div>:null}
          {!hidden&&olderHistoryError?<div role="alert" className="flex flex-wrap items-center justify-center gap-2 py-2 text-sm text-destructive"><span>{olderHistoryError}</span><Button variant="outline" size="sm" onClick={refreshHistory}>Refresh history</Button></div>:null}
          {hidden ? <p role="alert" className="text-sm text-destructive">{accessError??authorityError??"Conversation information is unavailable"}</p> : turns.map(task => <div key={task.id} data-task-id={task.id} className="space-y-5"><AgentMessage id={`${task.id}:user`} role="user" text={task.input} />{[...new Map([...historyMessages,...queued].filter(message=>message.taskId===task.id&&message.id.includes(":instruction:")).map(message=>[message.id,message])).values()].map(message=><AgentMessage key={message.id} id={message.id} role="user" text={message.text}/>)}<AgencyActivity key={`${scope}:${conversationId}:${task.id}`} task={task} observation={task.id === root.data?.task.id ? root.data : undefined} read={readActivity} onUnavailable={()=>setPaginationDenied(true)} onOpenSubagent={(item,button)=>openChild(item,button,task.id)} /><TaskResults key={(task.results??[]).map(result=>result.artifactId??result.id).join(":")} task={task} base={base}/></div>)}
          {!hidden && !turns.length && !history.isPending && !readiness.isPending ? <p className="py-12 text-center text-sm text-muted-foreground">How can I help with this client?</p> : null}
          {!hidden&&readiness.data && !readiness.data.ready ? <div className="space-y-3 rounded-xl border p-4"><p className="text-sm">{readiness.data.code === "MODEL_DEFAULT_REQUIRED" ? "Choose a model to start chatting." : "Agent unavailable"}</p><div className="flex flex-wrap gap-2">{readiness.data.canConfigureModel?<Button type="button" size="sm" onClick={()=>setModelOpen(true)}>Configure model</Button>:null}<Button type="button" variant="outline" size="sm" onClick={() => void readiness.refetch()}>Check readiness</Button></div></div> : null}
        </AgentConversationScroll>
        {error ? <p role="alert" className="px-4 py-2 text-sm text-destructive">{error}</p> : null}
        <AgentComposer textareaRef={composer} value={input} onChange={setInput} onSubmit={() => void submit()} label={canSteer ? "Update instructions" : "Message"} placeholder={canSteer ? "Add instructions…" : "Message your agent…"} sending={sending} disabled={!readiness.data?.ready || hidden || blocked || continuing} maxLength={canSteer?4000:32768} context={active ? <AgentContextUsage context={execution(active).context} /> : <span className="text-xs text-muted-foreground">{readiness.data?.model?.label}</span>} actions={<>{active?.canContinue ? <Button type="button" variant="outline" size="sm" disabled={sending || continuing || hidden || !readiness.data?.ready} onClick={() => void continueTask()}>{continuing ? "Continuing…" : "Continue"}</Button> : null}{working && active ? <Button type="button" variant="ghost" size="sm" disabled={sending || active.state === "cancel_requested"} onClick={() => { void command("tasks.cancel", { taskId: active.id }).then(() => cache.invalidateQueries({ queryKey: [...keys, "observation", active.id] })).catch(failure => setError(failure instanceof Error ? failure.message : "Could not stop work")); }}><Square className="size-3" />{active.state === "cancel_requested" ? "Stopping…" : "Stop"}</Button> : null}</>} />
      </div>
    </div>
    <AgentSubagentModal open={!!child} onOpenChange={open => { if (!open) {setChildPath([]);setChildRootId(null);} }} title={inspectedUnavailable ? "Agent" : inspected.data?.agentName ?? child?.name ?? "Agent"} state={inspectedUnavailable ? undefined : inspected.data?.task.state ?? child?.state} errorCode={inspectedUnavailable ? undefined : inspected.data?.task.errorCode} assignment={inspectedUnavailable ? undefined : inspected.data?.task.input} elapsedMs={inspectedUnavailable ? null : inspected.data?.task.runtime?.elapsedMs} observedAt={inspected.data?.task.runtime?.observedAt} loading={inspected.isPending} error={inspectedUnavailable ? "Activity unavailable" : undefined} viewKey={`${scope}:${child?.id}`} onBack={childPath.length > 1 ? () => setChildPath(previous => previous.slice(0, -1)) : undefined} onCloseAutoFocus={event => { event.preventDefault(); if(trigger.current?.isConnected)trigger.current.focus();else composer.current?.focus(); }}>{inspected.data && !inspectedUnavailable && child && childRootId ? <><AgencyActivity key={`${scope}:${childRootId}:${child.id}`} task={inspected.data.task} observation={inspected.data} rootTaskId={childRootId} childTaskId={child.id} read={readActivity} onUnavailable={()=>setPaginationDenied(true)} onOpenSubagent={(item,button)=>openChild(item,button,childRootId)} showStatus={false} /><TaskResults key={`${scope}:${childRootId}:${child.id}:${(inspected.data.task.results??[]).map(result=>result.artifactId??result.id).join(":")}`} task={inspected.data.task} base={base} rootTaskId={childRootId} childTaskId={child.id}/></> : null}</AgentSubagentModal>
    <AgentMemoryPanel open={memoryOpen&&!hidden} onOpenChange={setMemoryOpen} scopeKey={scope} enabled={readiness.data?.memoryEnabled} load={page => command("memory.list", page ?? {}) as Promise<AgentMemoryPage>} mutate={(id, change) => command("memory.mutate", { memoryId: id, expectedRevision: change.expectedRevision, action: change.action, ...(change.content !== undefined ? { content: change.content } : {}), ...(change.assertion !== undefined ? { assertion: change.assertion } : {}) }, change.requestKey)} onEnabledChange={async (enabled, requestKey) => { const response = await command("memory.configure", { enabled, expectedRevision: readiness.data!.revision }, requestKey) as { memoryEnabled: boolean; revision: number }; cache.setQueryData<Readiness>([...keys, "readiness"], previous => previous ? { ...previous, ...response } : previous); }} />
    <Dialog open={modelOpen&&!hidden} onOpenChange={open=>{if(!modelBusy){setModelOpen(open);if(!open){setApiKey("");modelRequest.current=null;}}}}><DialogContent><DialogHeader><DialogTitle>Workspace model</DialogTitle><DialogDescription>Applies to new requests across this workspace.</DialogDescription></DialogHeader><form className="space-y-4" onSubmit={event=>{event.preventDefault();void configureModel();}}><label className="block space-y-2 text-sm"><span>Provider</span><select required value={providerId} onChange={event=>setProviderId(event.target.value)} disabled={modelBusy||providers.isPending} className="min-h-10 w-full rounded-md border bg-background px-3"><option value="">Select provider</option>{providers.data?.providers.map(provider=><option key={provider.id} value={provider.id}>{provider.name}</option>)}</select></label><label className="block space-y-2 text-sm"><span>Model ID</span><Input required value={modelId} onChange={event=>setModelId(event.target.value)} disabled={modelBusy} maxLength={256}/></label><label className="block space-y-2 text-sm"><span>API key</span><Input required type="password" autoComplete="off" value={apiKey} onChange={event=>setApiKey(event.target.value)} disabled={modelBusy} /></label>{modelError||providers.error?<p role="alert" className="text-sm text-destructive">{modelError??providers.error?.message}</p>:null}<DialogFooter><Button type="button" variant="outline" disabled={modelBusy} onClick={()=>{setModelOpen(false);setApiKey("");modelRequest.current=null;}}>Cancel</Button><Button type="submit" disabled={modelBusy||!providerId||!modelId.trim()||!apiKey.trim()}>{modelBusy?"Saving…":"Save model"}</Button></DialogFooter></form></DialogContent></Dialog>
  </div>;
}
