import * as restate from "@restatedev/restate-sdk";
import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError, terminalTaskStates } from "./contracts";
import { loadExecution, assertCurrentAuthority, beginOperation, finishOperation, settleTask, transaction,
  event, WORKFLOW_NAME, type TaskOutcome, type MemoryFence, type OperationRequest, type Execution } from "./execution";
import { MemoryStore } from "./memory";
import { buildContext, prepareCompaction, type ContextGroup, type ContextSource } from "./context";
import { callModel, estimateRequestTokens, requestDigest as modelRequestDigest, ModelOperationError, type HarnessMessage, type ModelRequest,
  type ModelResponse, type ModelAdapterOptions } from "./model";

export { settleTask } from "./execution";
export { retrieveFaqKnowledge } from "./tools";
import {fitUtf8,toolsFor,knowledge,executeTool,assertPublishedTools} from "./tools";
import { admitChildren, readChildResults, type DelegatedChild } from "./delegation";
import { toolDescriptor } from "./tool-descriptors";
export interface ActionState {id:string;state:"pending_review"|"approved"|"rejected"|"expired"|"invalidated"|"claimed"|"delivered"|"failed"|"uncertain";expiresAt:string;errorCode?:string|null}
export interface ActionRuntime {
  prepare(taskId:string,operationId:string,input:{connectionId:string;artifactId:string;title?:string}):Promise<ActionState>;
  getReview(taskId:string,reviewId:string):Promise<ActionState>;
  execute(taskId:string,actionId:string):Promise<ActionState>;
  reconcile(actionId:string):Promise<ActionState>;
}
export interface BusinessOptions extends ModelAdapterOptions {
  actions?:ActionRuntime;
  selectReportArtifact?:(taskId:string,name:string,generatedOutput:string)=>Promise<{id:string}>;
  executeSandbox?: (taskId:string,operationId:string,args:{code:string;inputArtifactIds?:string[]})=>Promise<unknown>;
}
type Result<T> = { ok: true; value: T } | { ok: false; code: string; uncertain: boolean };
interface Snapshot { id: string; messages: HarnessMessage[]; digest: string; estimatedTokens: number;
  memoryFence?: MemoryFence; historyCutoff: string }
const terminalSql = "('completed','incomplete','refused','failed','cancelled','uncertain')";

async function operation<T>(ctx: restate.WorkflowContext, pool: Pool, taskId: string, input: OperationRequest,
  perform: () => Promise<{ value: T; tokens: number }>, journalName = input.id): Promise<Result<T>> {
  for(let capacityAttempt=0;capacityAttempt<2400;capacityAttempt++) {
  const result:Result<T> = await ctx.run(capacityAttempt===0?journalName:`${journalName}:capacity:${capacityAttempt}`, async () => {
    let claimed = false;
    try {
      const admission = await beginOperation(pool, taskId, input);
      if (admission.replayed) {
        if (admission.operation.state === "completed") return { ok: true as const, value: admission.operation.output as T };
        return { ok: false as const, code: admission.operation.error_code ?? "OPERATION_OUTCOME_UNCERTAIN",
          uncertain: admission.operation.state === "uncertain" };
      }
      claimed = true;
      const result = await perform();
      if(input.kind==="resource" && Date.now()-new Date(admission.operation.started_at).getTime()>input.reservedMs) throw new ModelOperationError("RESOURCE_TIME_BOUND_EXCEEDED","uncertain");
      if(input.maxResultBytes!==undefined && Buffer.byteLength(JSON.stringify(result.value))>input.maxResultBytes) throw new PlatformError("TOOL_RESULT_LIMIT",413,"Tool result exceeded its published bound");
      if (result.tokens > input.reservedTokens) throw new ModelOperationError("MODEL_ACCOUNTING_BOUND_EXCEEDED", "uncertain");
      await finishOperation(pool, taskId, input.id, "completed", result.value, null, result.tokens);
      return { ok: true as const, value: result.value };
    } catch (error) {
      if (!(error instanceof ModelOperationError) && !(error instanceof PlatformError)) throw error;
      const uncertain = error instanceof ModelOperationError && error.outcome === "uncertain";
      if (claimed) await finishOperation(pool, taskId, input.id, uncertain ? "uncertain" : "failed", null, error.code, uncertain ? input.reservedTokens : 0);
      return { ok: false as const, code: error.code, uncertain };
    }
  });
  if(result.ok || result.code!=="PROVIDER_BUSY") return result;
  await ctx.sleep(250);
  }
  return {ok:false,code:"ROOT_LIMIT",uncertain:false};
}

async function awaitAuthority(ctx: restate.WorkflowContext, pool: Pool, taskId: string, label: string): Promise<Execution | TaskOutcome> {
  for (let renewal = 0; renewal < 8; renewal++) {
    const status = await ctx.run(`${label}:check:${renewal}`, async () => {
      const loaded = await loadExecution(pool, taskId);
      if (terminalTaskStates.has(loaded.task.state)) return { settled: true, execution: loaded };
      try {
        await transaction(pool, async db => assertCurrentAuthority(db, await loadExecution(db, taskId, true)));
        return { active: true, execution: loaded };
      } catch (error) {
        if (!(error instanceof PlatformError)) throw error;
        if (error.code !== "AUTHORITY_EXPIRED") return { denied: error.code };
        await pool.query("UPDATE agents_platform.tasks SET state='waiting_authority' WHERE id=$1 AND state IN ('accepted','running','waiting_review')", [taskId]);
        await event(pool, taskId, `authority-wait:${loaded.task.control_generation}`, "authority.required");
        return { generation: loaded.task.control_generation, deadline: new Date(loaded.task.deadline_at).getTime() };
      }
    });
    if (status.denied) throw new PlatformError(status.denied, 403, "Execution authorization is unavailable");
    if (status.settled) return { state: status.execution!.task.state as TaskOutcome["state"], output: status.execution!.task.output ?? undefined,
      errorCode: status.execution!.task.error_code ?? undefined };
    if (status.active) return status.execution!;
    const resumed = await restate.RestatePromise.race([
      ctx.promise(`authority:${status.generation}`).get().map(() => true),
      ctx.sleep(Math.max(1, status.deadline! - await ctx.date.now())).map(() => false),
    ]);
    if (!resumed) throw new PlatformError("TASK_DEADLINE", 409, "Task deadline reached");
  }
  throw new PlatformError("GRANT_INACTIVE", 403, "Fresh authorization required");
}

async function buildSnapshot(pool: Pool, taskId: string, step: number, working: ContextGroup[], summary: ContextSource | undefined,
  omitted: string[], knownGeneration?: number, knownExpiry?: number): Promise<{ snapshot?: Snapshot; history: ContextGroup[]; working: ContextGroup[];
    memoryFence?: MemoryFence; invalidated: boolean; needsCompaction: boolean }> {
  const execution = await loadExecution(pool, taskId), task = execution.task, config = execution.configuration;
  const sources: ContextSource[] = (await knowledge(pool, taskId)).map(source => ({ id: source.id, revision: 1,
    kind: "knowledge", content: `${source.title}\n${fitUtf8(source.content, 1500)}` }));
  let memoryFence: MemoryFence | undefined;
  const memory = new MemoryStore(pool);
  if (config.memory.enabled) {
    const selected = await memory.read({ organizationId: task.organization_id, agentId: execution.agentId, principal: task.principal });
    const expiries = selected.memories.flatMap(item => item.expiresAt ? [new Date(item.expiresAt).getTime()] : []);
    memoryFence = { id: selected.scope.id, generation: selected.generation,
      ...(expiries.length ? { expiresAt: Math.min(...expiries) } : {}) };
    sources.push(...selected.memories.slice(0, 8).map(item => ({ id: item.id, revision: item.revision, kind: "memory" as const, content: fitUtf8(item.content, 512) })));
  }
  const skills = !config.skillIds.length ? [] : task.principal.kind==="automation" ?
    (await pool.query<{id:string;revision:number;body:string}>("SELECT id,revision,body FROM agents_platform.skill_revisions WHERE organization_id=$1 AND agent_id=$2 AND id=ANY($3::uuid[]) ORDER BY id",[task.organization_id,execution.agentId,config.skillIds])).rows :
    await memory.readSkills({ organizationId: task.organization_id, agentId: execution.agentId, principal: task.principal }, config.skillIds);
  const invalidated = (knownGeneration !== undefined && knownGeneration !== memoryFence?.generation) ||
    (knownExpiry !== undefined && Date.now() >= knownExpiry);
  const prior = (await pool.query(`SELECT t.id,t.input,t.output,t.state FROM agents_platform.tasks t
    WHERE t.conversation_id=$1 AND t.turn_sequence<$2 AND t.state IN ${terminalSql}
    AND NOT EXISTS(SELECT 1 FROM agents_platform.context_snapshots c WHERE c.task_id=t.id AND c.memory_scope_id=$3
      AND c.memory_generation<>$4) ORDER BY t.turn_sequence`,
  [task.conversation_id, task.turn_sequence, memoryFence?.id ?? null, memoryFence?.generation ?? null])).rows;
  const history: ContextGroup[] = prior.filter(t => !omitted.includes(t.id)).map(t => ({ id: t.id, messages: [
    { role: "user", content: t.input }, { role: "assistant", content: t.output ?? `Task ended: ${t.state}` },
  ] }));
  const active = invalidated ? [] : working;
  const input = { instructions: config.instructions, currentInput: task.input, history, workingGroups: active,
    summary: invalidated ? undefined : summary, sources,
    skills: skills.map(item => ({ id: item.id, revision: item.revision, kind: "skill" as const, content: item.body })),
    tools: toolsFor(config), model: config.model.model, maxInputTokens: config.context.maxInputTokens, maxOutputTokens: config.model.maxOutputTokens };
  let built;
  try { built = buildContext(input); }
  catch (error) {
    if (error instanceof ModelOperationError && error.code === "CONTEXT_LIMIT" && history.length + active.length > 1) {
      return { history, working: active, memoryFence, invalidated, needsCompaction: true };
    }
    throw error;
  }
  const totalGroups = history.length + active.length;
  if (built.status === "compaction_required" || (built.estimatedTokens >= config.context.compactAtTokens && totalGroups > 2)) {
    return { history, working: active, memoryFence, invalidated, needsCompaction: true };
  }
  const id = `context:${taskId}:${step}`;
  const row = (await pool.query(`INSERT INTO agents_platform.context_snapshots
    (id,task_id,step,digest,payload,source_references,memory_scope_id,memory_generation,history_cutoff)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING RETURNING id`,
  [id, taskId, step, built.digest, { messages: built.messages, estimatedTokens: built.estimatedTokens, memoryExpiresAt: memoryFence?.expiresAt }, JSON.stringify(built.sourceReferences),
    memoryFence?.id ?? null, memoryFence?.generation ?? null, task.history_cutoff ?? "0"])).rows[0];
  const saved = row ? undefined : (await pool.query("SELECT * FROM agents_platform.context_snapshots WHERE id=$1", [id])).rows[0];
  const snapshot: Snapshot = saved ? { id, ...saved.payload, digest: saved.digest, historyCutoff: saved.history_cutoff,
    memoryFence: saved.memory_scope_id ? { id: saved.memory_scope_id, generation: Number(saved.memory_generation), expiresAt: saved.payload.memoryExpiresAt } : undefined } :
    { id, messages: built.messages, digest: built.digest, estimatedTokens: built.estimatedTokens, memoryFence, historyCutoff: task.history_cutoff ?? "0" };
  await event(pool, taskId, id, "context.prepared", { snapshotId: id, estimatedTokens: snapshot.estimatedTokens, compacted: Boolean(summary) });
  return { snapshot, history, working: active, memoryFence: snapshot.memoryFence, invalidated, needsCompaction: false };
}

function failed(result: { code: string; uncertain: boolean }): TaskOutcome {
  if (result.uncertain) return { state: "uncertain", errorCode: result.code };
  if (result.code === "TASK_CANCELLED") return { state: "cancelled" };
  if (["ROOT_LIMIT", "TASK_DEADLINE", "CONTEXT_LIMIT", "COMPACTION_INPUT_LIMIT", "TOOL_RESULT_LIMIT"].includes(result.code)) return { state: "incomplete", errorCode: result.code };
  return { state: "failed", errorCode: result.code };
}

function actionState(value:ActionState):ActionState {return{id:value.id,state:value.state,expiresAt:value.expiresAt,...(value.errorCode?{errorCode:value.errorCode}:{})};}

async function runRequiredReport(ctx:restate.WorkflowContext,pool:Pool,taskId:string,options:BusinessOptions,outcome:TaskOutcome,memoryFence?:MemoryFence):Promise<TaskOutcome> {
  const execution=await awaitAuthority(ctx,pool,taskId,"report-authority");
  if(!("configuration" in execution))return execution;
  const profile=execution.configuration.capabilities.workflows;
  if(!profile.enabled)return outcome;
  assertPublishedTools(execution.configuration,execution.toolBindings);
  if(!options.actions||!options.selectReportArtifact)throw new PlatformError("REPORT_WORKFLOW_UNAVAILABLE",503,"Report delivery is unavailable");
  const actions=options.actions;
  const prepared=await operation<ActionState>(ctx,pool,taskId,{id:`report:${taskId}:prepare`,kind:"tool",name:"report.prepare",request:{profile},reservedTokens:0,reservedMs:60000,retrySafe:true,maxResultBytes:8192,memoryFence},async()=>{
    const artifact=await options.selectReportArtifact!(taskId,profile.reportArtifactName,outcome.output??"");
    return{value:actionState(await actions.prepare(taskId,`report:${taskId}:deliver`,{connectionId:profile.connectionId,artifactId:artifact.id,title:profile.title})),tokens:0};
  });
  if(!prepared.ok)return failed(prepared);
  let action=prepared.value;
  for(let check=0;check<64;check++) {
    const status=await ctx.run(`report-review:${check}`,async()=>{
      const task=(await pool.query("SELECT state,control_generation,deadline_at FROM agents_platform.tasks WHERE id=$1",[taskId])).rows[0];
      if(!task)throw new PlatformError("TASK_NOT_FOUND",404,"Task not found");
      let fresh:ActionState;
      try{fresh=actionState(await actions.getReview(taskId,action.id));}catch(error){if(error instanceof PlatformError)return{denied:error.code};throw error;}
      if(fresh.state==="pending_review" && task.state!=="cancel_requested") {
        await pool.query("UPDATE agents_platform.tasks SET state='waiting_review',updated_at=now() WHERE id=$1 AND state='running'",[taskId]);
        await event(pool,taskId,`review:${fresh.id}`,"review.required",{reviewId:fresh.id,expiresAt:fresh.expiresAt});
      }
      return{action:fresh,state:task.state,generation:task.control_generation,deadline:Math.min(new Date(task.deadline_at).getTime(),new Date(fresh.expiresAt).getTime())};
    });
    if(status.denied) return failed({code:status.denied,uncertain:false});
    action=status.action!;
    if(status.state==="cancel_requested")return {state:"cancelled"};
    if(action.state!=="pending_review")break;
    await restate.RestatePromise.race([ctx.promise(`review:${status.generation}`).get(),ctx.sleep(Math.max(1,status.deadline!-await ctx.date.now()))]);
  }
  if(action.state==="pending_review")return{state:"incomplete",errorCode:"REVIEW_WAIT_LIMIT"};
  if(["rejected","expired","invalidated","failed"].includes(action.state))return{state:"incomplete",errorCode:action.errorCode??`ACTION_${action.state.toUpperCase()}`};
  if(action.state==="delivered")return outcome;
  if(action.state==="approved") {
    const authorized=await awaitAuthority(ctx,pool,taskId,"report-claim-authority");
    if(!("configuration" in authorized))return authorized;
    const descriptor=toolDescriptor("report.deliver")!;
    await ctx.run("report-dispatch-stage",()=>pool.query("UPDATE agents_platform.tasks SET state='running',updated_at=now() WHERE id=$1 AND state='waiting_review'",[taskId]).then(()=>undefined));
    const delivered=await operation<ActionState>(ctx,pool,taskId,{id:`report:${taskId}:dispatch`,kind:"tool",name:"report.deliver",request:{actionId:action.id},reservedTokens:0,reservedMs:descriptor.maxDurationMs,retrySafe:true,maxResultBytes:descriptor.maxResultBytes},async()=>({value:actionState(await actions.execute(taskId,action.id)),tokens:0}));
    if(!delivered.ok) {
      const recorded=await ctx.run("report-postclaim-inspection",()=>actions.getReview(taskId,action.id).then(actionState));
      if(!["claimed","uncertain","delivered"].includes(recorded.state))return failed(delivered);
      action=recorded;
    } else action=delivered.value;
  }
  for(let attempt=0;attempt<3 && ["claimed","uncertain"].includes(action.state);attempt++) {
    await ctx.run(`report-reconcile-stage:${attempt}`,()=>pool.query("UPDATE agents_platform.tasks SET state='reconciling',updated_at=now() WHERE id=$1 AND state='running'",[taskId]).then(()=>undefined));
    await ctx.sleep(1000*(attempt+1));
    action=await ctx.run(`report-reconcile:${attempt}`,async()=>{try{return actionState(await actions.reconcile(action.id));}catch(error){if(error instanceof PlatformError)return{...action,state:"uncertain" as const,errorCode:error.code};throw error;}});
  }
  await ctx.run("report-operation-receipt",async()=>{
    const pending=(await pool.query("SELECT state FROM agents_platform.operations WHERE id=$1 AND task_id=$2",[`report:${taskId}:dispatch`,taskId])).rows[0];
    if(pending?.state==="started")await finishOperation(pool,taskId,`report:${taskId}:dispatch`,action.state==="delivered"?"completed":"uncertain",actionState(action),action.errorCode??null,0);
  });
  await ctx.run("report-outcome",()=>event(pool,taskId,`report:${action.id}:outcome`,"action.outcome",{actionId:action.id,state:action.state}));
  if(action.state==="delivered")return outcome;
  if(["claimed","uncertain"].includes(action.state))return{state:"uncertain",errorCode:action.errorCode??"ACTION_OUTCOME_UNCERTAIN"};
  return{state:"incomplete",errorCode:action.errorCode??`ACTION_${action.state.toUpperCase()}`};
}

export function createBusinessWorkflow(pool: Pool, options: BusinessOptions) {
  return restate.workflow({ name: WORKFLOW_NAME, options: { workflowRetention: { days: 7 }, journalRetention: { days: 7 } }, handlers: {
    run: async (ctx: restate.WorkflowContext, input: { taskId: string }) => {
      if (ctx.key !== input.taskId) throw new restate.TerminalError("Task identity mismatch", { errorCode: 400 });
      const taskId = input.taskId;
      await ctx.run("bind-invocation", async () => {
        const updated = await pool.query(`UPDATE agents_platform.tasks SET runtime_invocation_id=$2 WHERE id=$1
          AND harness_release='owned-report-v1' AND (runtime_invocation_id IS NULL OR runtime_invocation_id=$2)`, [taskId, ctx.request().id]);
        if (!updated.rowCount) throw new restate.TerminalError("Runtime identity mismatch", { errorCode: 409 });
      });
      let outcome: TaskOutcome = { state: "incomplete", errorCode: "ROOT_LIMIT" };
      let working: ContextGroup[] = [], summary: ContextSource | undefined, omitted: string[] = [], knownGeneration: number | undefined, knownExpiry: number | undefined;
      let partialChildren=false,finalMemoryFence:MemoryFence|undefined;
      try {
        // Durable ordered waits release the worker. PostgreSQL only selects the predecessor; it does not advance the loop.
        const predecessor = await ctx.run("conversation-order", async () => {
          const { task } = await loadExecution(pool, taskId);
          if(task.parent_task_id) return undefined;
          return (await pool.query("SELECT id FROM agents_platform.tasks WHERE conversation_id=$1 AND turn_sequence<$2 ORDER BY turn_sequence DESC LIMIT 1",
            [task.conversation_id, task.turn_sequence])).rows[0]?.id as string | undefined;
        });
        if (predecessor) {
          const reference = await ctx.run("predecessor-runtime", async () => (await pool.query("SELECT runtime_invocation_id,state FROM agents_platform.tasks WHERE id=$1", [predecessor])).rows[0]);
          if (!terminalTaskStates.has(reference.state)) {
            // A stable keyed workflow call follows the same predecessor even if its outbox response was lost.
            try { await ctx.workflowClient<{ run: (ctx: restate.WorkflowContext, input: {taskId:string}) => Promise<TaskOutcome> }>({ name: WORKFLOW_NAME }, predecessor).run({ taskId: predecessor }); }
            catch (error) {
              if (!(error instanceof restate.TerminalError)) throw error;
              if (error.code !== 409) throw new PlatformError("PREDECESSOR_UNAVAILABLE",503,"Previous turn outcome is unavailable");
              await ctx.run("repair-cancelled-predecessor",()=>settleTask(pool,predecessor,{state:"cancelled"}));
            }
          }
        }
        await ctx.run("freeze-history-cutoff", async () => {
          await pool.query("UPDATE agents_platform.tasks SET history_cutoff=turn_sequence-1 WHERE id=$1 AND history_cutoff IS NULL", [taskId]);
        });
        for (let step = 0; step < 40; step++) {
          const execution = await awaitAuthority(ctx, pool, taskId, `authority:${step}`);
          if (!("configuration" in execution)) return execution;
          const config = execution.configuration;
          assertPublishedTools(config,execution.toolBindings);
          const contextResult = await ctx.run(`context:${step}`, async () => {
            try { return { ok: true as const, value: await buildSnapshot(pool, taskId, step, working, summary, omitted, knownGeneration, knownExpiry) }; }
            catch(error) { if(error instanceof PlatformError || error instanceof ModelOperationError) return {ok:false as const,code:error.code}; throw error; }
          });
          if (!contextResult.ok) { outcome=failed({code:contextResult.code,uncertain:false}); break; }
          const assembled = contextResult.value;
          if (assembled.invalidated) { working = assembled.working; summary = undefined; omitted = []; }
          finalMemoryFence=assembled.memoryFence;
          knownGeneration = assembled.memoryFence?.generation;
          knownExpiry = assembled.memoryFence?.expiresAt;
          if (assembled.needsCompaction) {
            const groups = [...assembled.history, ...assembled.working];
            const plan = prepareCompaction(groups, { retainRecent: Math.min(1, groups.length - 1), maxInputTokens: config.context.maxInputTokens,
              maxOutputTokens: Math.min(384, config.model.maxOutputTokens), previousSummary: summary });
            const request: ModelRequest = { messages: plan.messages, model: config.model.model, maxDurationSeconds: config.model.maxDurationSeconds,
              maxInputTokens: config.context.maxInputTokens, maxOutputTokens: Math.min(384, config.model.maxOutputTokens) };
            await ctx.run(`compact-context:${step}`, async () => {
              const digest = modelRequestDigest(request);
              await pool.query(`INSERT INTO agents_platform.context_snapshots(id,task_id,step,digest,payload,source_references,memory_scope_id,memory_generation,history_cutoff)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(id) DO NOTHING`,
              [`context:compact:${taskId}:${step}`,taskId,-step-1,digest,{messages:request.messages,estimatedTokens:plan.estimatedTokens,memoryExpiresAt:assembled.memoryFence?.expiresAt},
                JSON.stringify(plan.compactedGroupIds.map(id=>({id,revision:1,kind:"result"}))),assembled.memoryFence?.id??null,assembled.memoryFence?.generation??null,execution.task.history_cutoff??"0"]);
            });
            const compacted = await operation<ModelResponse>(ctx, pool, taskId, { id: `compact:${taskId}:${step}`, kind: "compaction", name: "context.compact",
              request, reservedTokens: estimateRequestTokens(request) + 512 + request.maxOutputTokens,
              reservedMs: config.model.maxDurationSeconds * 1000, memoryFence: assembled.memoryFence }, async () => {
                const value = await callModel(request, { ...options, signal: options.signal ? AbortSignal.any([options.signal, ctx.request().attemptCompletedSignal]) : ctx.request().attemptCompletedSignal });
                return { value, tokens: value.usage.inputTokens + value.usage.outputTokens };
              });
            if (!compacted.ok) {
              if (["AUTHORITY_EXPIRED","CONTEXT_INVALIDATED"].includes(compacted.code)) continue;
              outcome = failed(compacted); break;
            }
            if (compacted.value.finishReason !== "stop" || !compacted.value.message.content) { outcome = { state: "incomplete", errorCode: "COMPACTION_INVALID" }; break; }
            summary = { id: `compact:${taskId}:${step}`, revision: 1, kind: "summary", content: compacted.value.message.content };
            omitted.push(...plan.compactedGroupIds); working = working.filter(group => !plan.compactedGroupIds.includes(group.id));
            await ctx.run(`compaction-event:${step}`, () => event(pool, taskId, summary!.id, "context.compacted", { compactedGroups: plan.compactedGroupIds.length }));
            continue;
          }
          const snapshot = assembled.snapshot!;
          const request: ModelRequest = { messages: snapshot.messages, tools: toolsFor(config), model: config.model.model,
            maxInputTokens: config.context.maxInputTokens, maxOutputTokens: config.model.maxOutputTokens, maxDurationSeconds: config.model.maxDurationSeconds };
          const generated = await operation<ModelResponse>(ctx, pool, taskId, { id: `model:${taskId}:${step}`, kind: "model", name: "model.generate", request,
            reservedTokens: estimateRequestTokens(request) + 512 + config.model.maxOutputTokens,
            reservedMs: config.model.maxDurationSeconds * 1000, memoryFence: snapshot.memoryFence }, async () => {
              const value = await callModel(request, { ...options, signal: options.signal ? AbortSignal.any([options.signal, ctx.request().attemptCompletedSignal]) : ctx.request().attemptCompletedSignal });
              return { value, tokens: value.usage.inputTokens + value.usage.outputTokens };
            });
          if (!generated.ok) {
            if (["CONTEXT_INVALIDATED","AUTHORITY_EXPIRED"].includes(generated.code)) continue;
            outcome = failed(generated); break;
          }
          const response = generated.value;
          if (response.finishReason !== "tool_calls") {
            outcome = { state: response.finishReason === "stop" ? (partialChildren?"incomplete":"completed") : response.finishReason === "refusal" ? "refused" : "incomplete",
              output: response.message.content ?? undefined, ...(response.finishReason === "length" ? { errorCode: "MODEL_OUTPUT_LIMIT" } : partialChildren?{errorCode:"CHILD_PARTIAL_FAILURE"}:{}) }; break;
          }
          const messages: HarnessMessage[] = [response.message];
          let stop = false, refreshContext = false;
          for (let callIndex = 0; callIndex < response.message.tool_calls!.length; callIndex++) {
            const call = response.message.tool_calls![callIndex]!, name = call.function.name.replaceAll("_", "."), id = `tool:${taskId}:${step}:${callIndex}`;
            const descriptor=toolDescriptor(name);
            let result: Result<unknown> = { ok: false, code: "GRANT_INACTIVE", uncertain: false };
            for (let retry = 0; retry < 8; retry++) {
              const authorized = await awaitAuthority(ctx,pool,taskId,`tool-authority:${step}:${callIndex}:${retry}`);
              if (!("configuration" in authorized)) { outcome=authorized; stop=true; break; }
              result = await operation<unknown>(ctx, pool, taskId, { id, kind: descriptor?.effect==="delegation"?"delegation":descriptor?.effect==="resource"?"resource":"tool", name,
                request: { tool: name, arguments: call.function.arguments, version: descriptor?.version??"1" }, reservedTokens: 0, reservedMs: descriptor?.maxDurationMs??30000,
                retrySafe: descriptor?.retry!=="adapter_reconcile",reconcile:descriptor?.retry==="adapter_reconcile", maxResultBytes:descriptor?.maxResultBytes??8192,memoryFence: snapshot.memoryFence }, async () => {
                  if(!config.tools.includes(name as typeof config.tools[number]) || !descriptor) throw new PlatformError("TOOL_DENIED",403,"Tool is unavailable");
                  let args:unknown; try{args=JSON.parse(call.function.arguments);}catch{throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Tool arguments must be JSON");}
                  if(name==="agents.delegate") return {value:await admitChildren(pool,taskId,id,args),tokens:0};
                  if(name==="sandbox.analyze") {
                    if(!config.capabilities.sandbox.enabled || !options.executeSandbox) throw new PlatformError("SANDBOX_UNAVAILABLE",503,"Analysis is unavailable");
                    const parsed=z.strictObject({code:z.string().min(1).max(16384),inputArtifactIds:z.array(z.uuid()).max(32).optional()}).safeParse(args);
                    if(!parsed.success) throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Check the analysis arguments");
                    const value=await options.executeSandbox(taskId,id,parsed.data);
                    if(value && typeof value==="object" && "state" in value && value.state==="uncertain") throw new ModelOperationError("SANDBOX_OUTCOME_UNCERTAIN","uncertain");
                    return {value,tokens:0};
                  }
                  return {value:await executeTool(pool, taskId, id, name, call.function.arguments),tokens:0};
                }, `${id}:admission:${retry}`);
              if (result.ok || result.code !== "AUTHORITY_EXPIRED") break;
            }
            if(stop) break;
            if(result.ok && name==="agents.delegate") {
              const children=result.value as DelegatedChild[];
              await ctx.run(`children-wait:${step}:${callIndex}`,()=>pool.query("UPDATE agents_platform.tasks SET state='waiting_children',updated_at=now() WHERE id=$1 AND state='running'",[taskId]).then(()=>undefined));
              const pending=children.map(child=>ctx.workflowClient<{run:(ctx:restate.WorkflowContext,input:{taskId:string})=>Promise<TaskOutcome>}>({name:WORKFLOW_NAME},child.taskId).run({taskId:child.taskId}));
              for(const [index,invocation] of pending.entries()) {
                try{await invocation;}catch(error){
                  if(!(error instanceof restate.TerminalError)) throw error;
                  await ctx.run(`child-terminal:${children[index]!.taskId}`,()=>settleTask(pool,children[index]!.taskId,{state:error.code===409?"cancelled":"uncertain",errorCode:"CHILD_RUNTIME_TERMINAL"}));
                }
              }
              const authorized=await awaitAuthority(ctx,pool,taskId,`children-result-authority:${step}:${callIndex}`);
              if(!("configuration" in authorized)){outcome=authorized;stop=true;break;}
              const joined=await ctx.run(`children-result:${step}:${callIndex}`,async()=>{
                try{return {ok:true as const,value:await readChildResults(pool,taskId,children)};}catch(error){if(error instanceof PlatformError)return {ok:false as const,code:error.code};throw error;}
              });
              if(!joined.ok) throw new PlatformError(joined.code,403,"Specialist results are unavailable");
              if(joined.value.children.some(child=>child.state==="uncertain")) {outcome={state:"uncertain",errorCode:"CHILD_OUTCOME_UNCERTAIN"};stop=true;break;}
              partialChildren ||= joined.value.partial;
              result={ok:true,value:joined.value};
              await ctx.run(`children-resume:${step}:${callIndex}`,()=>pool.query("UPDATE agents_platform.tasks SET state='running',updated_at=now() WHERE id=$1 AND state='waiting_children'",[taskId]).then(()=>undefined));
            }
            if(!result.ok && result.code==="CONTEXT_INVALIDATED") { refreshContext=true; break; }
            if (!result.ok && (result.uncertain || ["TASK_CANCELLED", "GRANT_REVOKED", "MEMBERSHIP_INACTIVE", "ROOT_LIMIT", "AUTHORITY_EXPIRED"].includes(result.code))) {
              outcome = failed(result); stop = true; break;
            }
            if(result.ok && Buffer.byteLength(JSON.stringify(result.value))>(descriptor?.maxResultBytes??8192)) {outcome={state:"incomplete",errorCode:"TOOL_RESULT_LIMIT"};stop=true;break;}
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result.ok ? result.value : { error: result.code }) });
          }
          if (stop) break;
          if (refreshContext) continue;
          working.push({ id: `round:${taskId}:${step}`, messages });
        }
        if(outcome.state==="completed")outcome=await runRequiredReport(ctx,pool,taskId,options,outcome,finalMemoryFence);
      } catch (error) {
        if (error instanceof restate.CancelledError) {
          await ctx.run("settle-cancellation", () => settleTask(pool, taskId, { state: "cancelled" })); throw error;
        }
        if (error instanceof PlatformError || error instanceof ModelOperationError) outcome = failed({ code: error.code, uncertain: error instanceof ModelOperationError && error.outcome === "uncertain" });
        else throw error;
      }
      await ctx.run("settle-task", () => settleTask(pool, taskId, outcome));
      return outcome;
    },
    review: async (ctx:restate.WorkflowSharedContext,input:{generation:number})=>{
      if(!Number.isSafeInteger(input.generation)||input.generation<0)throw new restate.TerminalError("Invalid review control",{errorCode:409});
      const allowed=await ctx.run("verify-review-control",async()=>Boolean((await pool.query(`SELECT 1 FROM agents_platform.task_controls c JOIN agents_platform.tasks t ON t.id=c.task_id
        WHERE c.task_id=$1 AND c.generation=$2 AND c.kind='review' AND c.generation<t.control_generation`,[ctx.key,input.generation])).rowCount));
      if(!allowed)throw new restate.TerminalError("Review control unavailable",{errorCode:409});
      await ctx.promise(`review:${input.generation}`).resolve(true);return{accepted:true};
    },
    resume: async (ctx: restate.WorkflowSharedContext, input: { generation: number }) => {
      const execution = await ctx.run("verify-current-grant", async () => {
        try {
          return await transaction(pool,async db=>{const current=await loadExecution(db,ctx.key,true);await assertCurrentAuthority(db,current);return current;});
        } catch(error) {
          if(error instanceof PlatformError) throw new restate.TerminalError(error.message,{errorCode:error.statusCode});
          throw error;
        }
      });
      if (!Number.isSafeInteger(input.generation) || input.generation < 0 || input.generation >= Number(execution.task.control_generation)) throw new restate.TerminalError("Invalid continuation", {errorCode:409});
      await ctx.promise(`authority:${input.generation}`).resolve(true);
      return { accepted: true };
    },
  } });
}
