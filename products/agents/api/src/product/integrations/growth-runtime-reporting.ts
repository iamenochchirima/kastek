import type { Pool } from "pg";
import type { GrowthAgentRuntime, GrowthAgentRuntimeOperation } from "@kasitek-labs/contracts";
import { PlatformError, terminalTaskStates } from "../../contracts/contracts";
import { assertCurrentEvidence, taskEvidenceManifest } from "../../execution/context/evidence";
import { elapsedTaskTime, readTaskTiming } from "../../execution/lifecycle/timing";
import { builtinToolName } from "../../capabilities/tool-definitions";
import { toolDescriptorPresentation } from "../../capabilities/tool-descriptors";
import { capabilityBindingPresentation } from "../../capabilities/tool-presentation";
import { capabilityBindingSchema } from "../../contracts/capability-catalog";

const operationLimit = 60;
export const productOperationMetadataSql=`coalesce((SELECT binding->'definition'->>'providerOperation'
      FROM jsonb_array_elements(coalesce(coalesce(t.effective_configuration,v.configuration)->'productBindings','[]'::jsonb)) binding
      WHERE binding->>'alias'=o.name LIMIT 1),o.name) name,
    (SELECT binding->'definition'->>'description'
      FROM jsonb_array_elements(coalesce(coalesce(t.effective_configuration,v.configuration)->'productBindings','[]'::jsonb)) binding
      WHERE binding->>'alias'=o.name LIMIT 1) catalog_description,
    coalesce((SELECT binding
      FROM jsonb_array_elements(coalesce(coalesce(t.effective_configuration,v.configuration)->'productBindings','[]'::jsonb)) binding
      WHERE binding->>'alias'=o.name LIMIT 1),
      (SELECT b.binding FROM agents_platform.capability_bindings b WHERE b.alias=o.name AND b.organization_id=t.organization_id LIMIT 1)) catalog_binding`;
const terminalStates: ReadonlySet<string> = terminalTaskStates;
const number = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const count = (value: unknown): number | null => number(typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : value);
const instant = (value: unknown): string | null => {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
};
const span = (from: unknown, to: unknown): number => Math.max(0, Date.parse(instant(to) ?? "") - Date.parse(instant(from) ?? "")) || 0;
const labels: Record<string, string> = {
  "workspace.read": "Reading workspace context", "content.list": "Finding content", "content.read": "Reading content",
  "content.posts.list": "Finding posts", "content.posts.get": "Reading a post", "content.posts.draft.create": "Creating a draft",
  "content.media.list": "Finding media", "content.media.get": "Reading media", "content.media.preview": "Previewing media",
  "content.media.update": "Updating media", "content.media.usage": "Checking media usage",
  "content.media.archive": "Archiving media", "content.media.restore": "Restoring media",
  "content.templates.list": "Finding templates", "content.templates.get": "Reading a template",
  "content.templates.create": "Saving a template", "content.templates.update": "Updating a template",
  "content.templates.render": "Previewing a template", "content.templates.instantiate": "Creating a draft",
  "content.templates.archive": "Archiving a template", "content.templates.restore": "Restoring a template",
  "campaigns.list": "Finding campaigns", "campaigns.read": "Reading campaigns", "analytics.read": "Reading analytics",
  "connections.list": "Checking connections", "draft.prepare": "Preparing a draft review",
  "knowledge.search": "Searching knowledge", "context.compact": "Compacting context",
  "tools.discover":"Finding tools", "tools.load":"Loading tools", "history.search":"Searching retained records", "history.read":"Reading retained records",
  "memory.search":"Searching memory", "memory.read":"Reading memory", "memory.propose":"Proposing memory", "skills.activate":"Loading a skill", "skills.read":"Reading a skill",
  "agents_discover": "Finding specialists", "agents_start": "Starting specialist work",
  "agents_status": "Checking specialists", "agents_wait": "Waiting for specialists",
  "agents_result": "Reading specialist results", "agents_followup": "Revising specialist work",
  "agents_cancel": "Stopping specialist work", "work_update": "Updating the plan",
  "work_inspect": "Checking progress", "product_workspace_read": "Reading workspace context",
  "product_content_list": "Finding content", "product_content_read": "Reading content",
  "product_campaigns_list": "Finding campaigns", "product_campaigns_read": "Reading campaigns",
  "product_analytics_read": "Reading analytics", "product_draft_prepare": "Preparing a draft review",
};
function catalogLabel(description:unknown):string|undefined{
  if(typeof description!=="string")return;
  const text=description.replace(/\s+/gu," ").trim();
  if(!text)return;
  const sentence=text.match(/^.*?[.!?](?=\s|$)/u)?.[0]??text;
  return sentence.length<=120?sentence:sentence.slice(0,119).trimEnd()+"…";
}
function label(kind: string, name: string, description?:unknown): string {
  if (kind === "model") return "Generating response";
  if (kind === "compaction") return "Compacting context";
  if (kind === "delegation") return "Coordinating specialists";
  if (kind === "resource") return "Preparing resources";
  return labels[name] ?? labels[name.replaceAll(".", "_")] ?? catalogLabel(description) ?? (name.startsWith("product_") ? "Using Growth" : "Using a tool");
}
/** Public labels use accepted catalogue metadata; execution names remain explicit diagnostics. */
export function operationPresentation(kind: string, name: string, acceptedBinding?: unknown, description?: unknown): Pick<GrowthAgentRuntimeOperation, "label" | "category" | "source" | "activityKind" | "technicalName"> {
  const binding = acceptedBinding ? capabilityBindingSchema.safeParse(acceptedBinding) : null;
  const canonical = builtinToolName(name) ?? name;
  const presentation = binding?.success ? capabilityBindingPresentation(binding.data) : toolDescriptorPresentation(canonical);
  const activityKind = !binding?.success && canonical === "tools.discover" ? "capability_discovery" as const
    : !binding?.success && canonical === "tools.load" ? "capability_loading" as const : undefined;
  return { label: presentation?.title ?? label(kind, name, description), ...(presentation?.category ? {category:presentation.category} : {}), ...(presentation?.source === "runtime" || presentation?.source === "product" || presentation?.source === "connection" ? {source:presentation.source} : {}),
    ...(activityKind ? {activityKind} : {}), ...(presentation ? {technicalName: (binding?.success ? binding.data.definition.providerOperation : canonical).slice(0,512)} : {}) };
}
interface Root { id: string; organization_id: string; principal: unknown; created_at: unknown; updated_at: unknown; state: string;work_id?:string;root_task_id?:string }
interface RuntimeRows {
  tasks: { id: string; name: string; tokens_used: unknown; model_calls: unknown; tool_calls: unknown }[];
  operations: { id: string; task_id: string; kind: string; name: string; catalog_description?:unknown; catalog_binding?:unknown; state: string; started_at: unknown; completed_at: unknown; error_code: unknown }[];
  aggregate: { input_tokens?: unknown; output_tokens?: unknown; observed_calls?: unknown; operation_count?: unknown; compaction_count?: unknown; last_compacted_at?: unknown; compacting?: boolean };
  snapshot?: { estimated_tokens?: unknown; history_count?: unknown; source_count?: unknown; compacted?: unknown };
  route?: { model_id?: unknown; provider_id?: unknown; policy?: Record<string, unknown> };
  timing?: { duration_ms?: unknown; first_token_ms?: unknown; output_tokens?: unknown };
}
/** Safe scalar projection plus accepted catalogue presentation; bindings and message bodies are never returned. */
export function projectGrowthRuntime(root: Root, rows: RuntimeRows, now = new Date()): GrowthAgentRuntime {
  const observedAt = now.toISOString(), policy = rows.route?.policy;
  const estimated = count(rows.snapshot?.estimated_tokens), window = count(policy?.contextTokens), compactAt = count(policy?.compactAtTokens),inputLimit=count(policy?.maxInputTokens);
  const available=[inputLimit,window].filter((value):value is number=>value!==null&&value>0),effectiveInput=available.length?Math.min(...available):null;
  const duration = count(rows.timing?.duration_ms), first = count(rows.timing?.first_token_ms), output = count(rows.timing?.output_tokens);
  const agentNames = new Map(rows.tasks.map(task => [task.id, task.name.slice(0, 256)]));
  const operations = rows.operations.slice(0, operationLimit).sort((left,right)=>Date.parse(instant(left.started_at)??"")-Date.parse(instant(right.started_at)??"")||left.id.localeCompare(right.id)).flatMap((operation): GrowthAgentRuntimeOperation[] => {
    if (!["model", "compaction", "tool", "delegation", "resource"].includes(operation.kind) || !["started", "completed", "failed", "uncertain"].includes(operation.state)) return [];
    const startedAt = instant(operation.started_at); if (!startedAt) return [];
    return [{ id: operation.id, taskId: operation.task_id, agentName: agentNames.get(operation.task_id) ?? "Agent",
      kind: operation.kind as GrowthAgentRuntimeOperation["kind"], ...operationPresentation(operation.kind, operation.name, operation.catalog_binding, operation.catalog_description),
      state: operation.state as GrowthAgentRuntimeOperation["state"], startedAt, completedAt: instant(operation.completed_at),
      durationMs: span(startedAt, operation.completed_at ?? observedAt),
      errorCode: typeof operation.error_code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(operation.error_code) ? operation.error_code : null }];
  });
  return { version: 1, observedAt, elapsedMs: elapsedTaskTime(root.created_at, terminalStates.has(root.state) ? root.updated_at : observedAt),
    model: { id: typeof rows.route?.model_id === "string" ? rows.route.model_id.slice(0, 256) : null,
      provider: typeof rows.route?.provider_id === "string" ? rows.route.provider_id.slice(0, 64) : null,
      latencyMs: duration, firstTokenMs: first,
      outputTokensPerSecond: output !== null && duration !== null && duration > 0 ? output / (duration / 1000) : null },
    context: { estimatedInputTokens: estimated, inputLimitTokens: inputLimit, windowTokens: window,
      reservedOutputTokens: count(policy?.maxOutputTokens), safetyTokens: count(policy?.safetyTokens),
      compactAtTokens: compactAt, pressure: rows.aggregate.compacting ? "compaction_due" : estimated === null || compactAt === null ? null : estimated >= compactAt ? "compaction_due" : "normal",
      decision: rows.aggregate.compacting ? "compacting" : rows.snapshot ? rows.snapshot.compacted === true ? "compacted" : "prepared" : null,
      utilizationPercent: estimated !== null && effectiveInput !== null ? estimated / effectiveInput * 100 : null,
      compactionCount: count(rows.aggregate.compaction_count) ?? 0, lastCompactedAt: instant(rows.aggregate.last_compacted_at),
      historyGroups: count(rows.snapshot?.history_count), sourceCount: count(rows.snapshot?.source_count) },
    usage: { accountedTokens: rows.tasks.reduce((sum, task) => sum + (count(task.tokens_used) ?? 0), 0),
      inputTokens: count(rows.aggregate.input_tokens), outputTokens: count(rows.aggregate.output_tokens),
      modelCalls: rows.tasks.reduce((sum, task) => sum + (count(task.model_calls) ?? 0), 0),
      toolCalls: rows.tasks.reduce((sum, task) => sum + (count(task.tool_calls) ?? 0), 0), observedModelCalls: count(rows.aggregate.observed_calls) ?? 0 },
    operations, operationsTruncated: (count(rows.aggregate.operation_count) ?? 0) > operationLimit };
}
/** Called only after the Growth task/evidence authority check. Descendants retain independent evidence checks. */
export async function readTaskRuntime(pool: Pool, root: Root, product:"agents"|"growth"|"agencies"="growth"): Promise<GrowthAgentRuntime> {
  await assertCurrentEvidence(pool,root.id,await taskEvidenceManifest(pool,root.id),{requireActiveTask:false});
  const tasks = (await pool.query(`WITH RECURSIVE family AS (
      SELECT id,ARRAY[id] AS path FROM agents_platform.tasks WHERE id=$1
      UNION ALL SELECT t.id,f.path||t.id FROM agents_platform.tasks t JOIN family f ON t.parent_task_id=f.id
      WHERE NOT t.id=ANY(f.path)
    ) SELECT t.id,t.parent_task_id,a.name,t.tokens_used,t.model_calls,t.tool_calls
    FROM family f JOIN agents_platform.tasks t ON t.id=f.id JOIN agents_platform.agent_versions v ON v.id=t.version_id AND v.organization_id=t.organization_id
    JOIN agents_platform.agents a ON a.id=v.agent_id AND a.organization_id=t.organization_id
    JOIN agents_platform.conversations c ON c.id=t.conversation_id
    WHERE t.product=$4 AND t.organization_id=$2 AND t.principal=$3::jsonb AND c.deleted_at IS NULL
      ORDER BY t.created_at,t.id`,
  [root.id, root.organization_id, JSON.stringify(root.principal),product])).rows;
  const visible = [];
  for (const task of tasks) {
    if (task.parent_task_id) {
      try { await assertCurrentEvidence(pool, task.id, await taskEvidenceManifest(pool, task.id), { requireActiveTask: false }); }
      catch (error) { if (error instanceof PlatformError && [403,404,409,503].includes(error.statusCode)) continue; throw error; }
    }
    visible.push(task);
  }
  const ids = visible.map(task => task.id);
  const operations = (await pool.query(`SELECT o.id,o.task_id,o.kind,
    ${productOperationMetadataSql},
    o.state,o.started_at,o.completed_at,o.error_code
    FROM agents_platform.operations o JOIN agents_platform.tasks t ON t.id=o.task_id
    JOIN agents_platform.agent_versions v ON v.id=t.version_id AND v.organization_id=t.organization_id
    WHERE o.task_id=ANY($1::uuid[]) ORDER BY (o.state='started') DESC,o.started_at DESC,o.id DESC LIMIT $2`, [ids, operationLimit])).rows;
  const aggregate = (await pool.query(`SELECT count(*)::int operation_count,
    count(*) FILTER(WHERE task_id=$2 AND kind='compaction' AND state='completed')::int compaction_count,
    max(completed_at) FILTER(WHERE task_id=$2 AND kind='compaction' AND state='completed') last_compacted_at,
    bool_or(task_id=$2 AND kind='compaction' AND state='started') compacting,
    count(*) FILTER(WHERE kind IN ('model','compaction') AND output->'usage'->>'observed'='true')::int observed_calls,
    sum(CASE WHEN kind IN ('model','compaction') AND output->'usage'->>'observed'='true' AND jsonb_typeof(output->'usage'->'inputTokens')='number' THEN (output->'usage'->>'inputTokens')::numeric END) input_tokens,
    sum(CASE WHEN kind IN ('model','compaction') AND output->'usage'->>'observed'='true' AND jsonb_typeof(output->'usage'->'outputTokens')='number' THEN (output->'usage'->>'outputTokens')::numeric END) output_tokens
    FROM agents_platform.operations WHERE task_id=ANY($1::uuid[])`, [ids,root.id])).rows[0] ?? {};
  const snapshot = (await pool.query(`SELECT payload->'estimatedTokens' estimated_tokens,
    jsonb_array_length(CASE WHEN jsonb_typeof(payload->'historyGroupIds')='array' THEN payload->'historyGroupIds' ELSE '[]'::jsonb END) history_count,
    jsonb_array_length(CASE WHEN jsonb_typeof(source_references)='array' THEN source_references ELSE '[]'::jsonb END) source_count
    FROM agents_platform.context_snapshots WHERE task_id=$1 AND id LIKE 'context:%' ORDER BY step DESC LIMIT 1`, [root.id])).rows[0];
  if(snapshot) snapshot.compacted=(await pool.query(`SELECT payload->'compacted' compacted FROM agents_platform.task_events WHERE task_id=$1 AND kind='context.prepared' ORDER BY sequence DESC LIMIT 1`,[root.id])).rows[0]?.compacted;
  const route = (await pool.query(`SELECT routes->'primary'->'binding'->>'modelId' model_id,
    routes->'primary'->'binding'->>'providerId' provider_id,routes->'primary'->'policy' policy
    FROM agents_platform.task_model_routes WHERE task_id=$1 AND organization_id=$2`, [root.id, root.organization_id])).rows[0];
  const timing = (await pool.query(`SELECT payload->'durationMs' duration_ms,payload->'firstTokenMs' first_token_ms,payload->'outputTokens' output_tokens
    FROM agents_platform.task_events WHERE task_id=$1 AND kind='model.observed' AND payload->>'role'='primary' ORDER BY sequence DESC LIMIT 1`, [root.id])).rows[0];
  const taskTiming=await readTaskTiming(pool,root);
  return {...projectGrowthRuntime(root, { tasks: visible, operations, aggregate, snapshot, route, timing },new Date(taskTiming.observedAt)),
    elapsedMs:taskTiming.elapsedMs,workId:taskTiming.workId,workElapsedMs:taskTiming.workElapsedMs};
}
export async function readGrowthRuntime(pool:Pool,root:Root,product:"growth"|"agencies"="growth"):Promise<GrowthAgentRuntime>{
  return readTaskRuntime(pool,root,product);
}
