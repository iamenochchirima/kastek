import type { Pool } from "pg";
import type { GrowthAgentRuntime, GrowthAgentRuntimeOperation } from "@kasitek-labs/contracts";
import { PlatformError, terminalTaskStates } from "../../contracts/contracts";
import { assertCurrentEvidence, taskEvidenceManifest } from "../../execution/context/evidence";

const operationLimit = 60;
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
  "content.posts.list": "Finding posts", "content.posts.get": "Reading a post", "content.posts.draft.create": "Creating a reviewed draft",
  "campaigns.list": "Finding campaigns", "campaigns.read": "Reading campaigns", "analytics.read": "Reading analytics",
  "connections.list": "Checking connections", "draft.prepare": "Preparing a draft review",
  "knowledge.search": "Searching knowledge", "context.compact": "Compacting context",
  "agents_discover": "Finding specialists", "agents_start": "Starting specialist work",
  "agents_status": "Checking specialists", "agents_wait": "Waiting for specialists",
  "agents_result": "Reading specialist results", "agents_followup": "Revising specialist work",
  "agents_cancel": "Stopping specialist work", "work_update": "Updating the plan",
  "work_inspect": "Checking progress", "product_workspace_read": "Reading workspace context",
  "product_content_list": "Finding content", "product_content_read": "Reading content",
  "product_campaigns_list": "Finding campaigns", "product_campaigns_read": "Reading campaigns",
  "product_analytics_read": "Reading analytics", "product_draft_prepare": "Preparing a draft review",
};
function label(kind: string, name: string): string {
  if (kind === "model") return "Generating response";
  if (kind === "compaction") return "Compacting context";
  if (kind === "delegation") return "Coordinating specialists";
  if (kind === "resource") return "Preparing resources";
  return labels[name] ?? labels[name.replaceAll(".", "_")] ?? (name.startsWith("product_") ? "Using Growth" : "Using a tool");
}
interface Root { id: string; organization_id: string; principal: unknown; created_at: unknown; updated_at: unknown; state: string }
interface RuntimeRows {
  tasks: { id: string; name: string; tokens_used: unknown; model_calls: unknown; tool_calls: unknown }[];
  operations: { id: string; task_id: string; kind: string; name: string; state: string; started_at: unknown; completed_at: unknown; error_code: unknown }[];
  aggregate: { input_tokens?: unknown; output_tokens?: unknown; observed_calls?: unknown; operation_count?: unknown; compaction_count?: unknown; last_compacted_at?: unknown; compacting?: boolean };
  snapshot?: { estimated_tokens?: unknown; history_count?: unknown; source_count?: unknown; compacted?: unknown };
  route?: { model_id?: unknown; provider_id?: unknown; policy?: Record<string, unknown> };
  timing?: { duration_ms?: unknown; first_token_ms?: unknown; output_tokens?: unknown };
}
/** Pure scalar projection. Deliberately does not accept request, result or context message bodies. */
export function projectGrowthRuntime(root: Root, rows: RuntimeRows, now = new Date()): GrowthAgentRuntime {
  const observedAt = now.toISOString(), policy = rows.route?.policy;
  const estimated = count(rows.snapshot?.estimated_tokens), window = count(policy?.contextTokens), compactAt = count(policy?.compactAtTokens);
  const duration = count(rows.timing?.duration_ms), first = count(rows.timing?.first_token_ms), output = count(rows.timing?.output_tokens);
  const agentNames = new Map(rows.tasks.map(task => [task.id, task.name.slice(0, 256)]));
  const operations = rows.operations.slice(0, operationLimit).sort((left,right)=>Date.parse(instant(left.started_at)??"")-Date.parse(instant(right.started_at)??"")||left.id.localeCompare(right.id)).flatMap((operation): GrowthAgentRuntimeOperation[] => {
    if (!["model", "compaction", "tool", "delegation", "resource"].includes(operation.kind) || !["started", "completed", "failed", "uncertain"].includes(operation.state)) return [];
    const startedAt = instant(operation.started_at); if (!startedAt) return [];
    return [{ id: operation.id, taskId: operation.task_id, agentName: agentNames.get(operation.task_id) ?? "Agent",
      kind: operation.kind as GrowthAgentRuntimeOperation["kind"], label: label(operation.kind, operation.name),
      state: operation.state as GrowthAgentRuntimeOperation["state"], startedAt, completedAt: instant(operation.completed_at),
      durationMs: span(startedAt, operation.completed_at ?? observedAt),
      errorCode: typeof operation.error_code === "string" && /^[A-Z][A-Z0-9_]{0,99}$/.test(operation.error_code) ? operation.error_code : null }];
  });
  return { version: 1, observedAt, elapsedMs: span(root.created_at, terminalStates.has(root.state) ? root.updated_at : observedAt),
    model: { id: typeof rows.route?.model_id === "string" ? rows.route.model_id.slice(0, 256) : null,
      provider: typeof rows.route?.provider_id === "string" ? rows.route.provider_id.slice(0, 64) : null,
      latencyMs: duration, firstTokenMs: first,
      outputTokensPerSecond: output !== null && duration !== null && duration > 0 ? output / (duration / 1000) : null },
    context: { estimatedInputTokens: estimated, inputLimitTokens: count(policy?.maxInputTokens), windowTokens: window,
      reservedOutputTokens: count(policy?.maxOutputTokens), safetyTokens: count(policy?.safetyTokens),
      compactAtTokens: compactAt, pressure: rows.aggregate.compacting ? "compaction_due" : estimated === null || compactAt === null ? null : estimated >= compactAt ? "compaction_due" : "normal",
      decision: rows.aggregate.compacting ? "compacting" : rows.snapshot ? rows.snapshot.compacted === true ? "compacted" : "prepared" : null,
      utilizationPercent: estimated !== null && window !== null && window > 0 ? estimated / window * 100 : null,
      compactionCount: count(rows.aggregate.compaction_count) ?? 0, lastCompactedAt: instant(rows.aggregate.last_compacted_at),
      historyGroups: count(rows.snapshot?.history_count), sourceCount: count(rows.snapshot?.source_count) },
    usage: { accountedTokens: rows.tasks.reduce((sum, task) => sum + (count(task.tokens_used) ?? 0), 0),
      inputTokens: count(rows.aggregate.input_tokens), outputTokens: count(rows.aggregate.output_tokens),
      modelCalls: rows.tasks.reduce((sum, task) => sum + (count(task.model_calls) ?? 0), 0),
      toolCalls: rows.tasks.reduce((sum, task) => sum + (count(task.tool_calls) ?? 0), 0), observedModelCalls: count(rows.aggregate.observed_calls) ?? 0 },
    operations, operationsTruncated: (count(rows.aggregate.operation_count) ?? 0) > operationLimit };
}
/** Called only after the Growth task/evidence authority check. Descendants retain independent evidence checks. */
export async function readGrowthRuntime(pool: Pool, root: Root): Promise<GrowthAgentRuntime> {
  const tasks = (await pool.query(`SELECT t.id,t.parent_task_id,a.name,t.tokens_used,t.model_calls,t.tool_calls
    FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id AND v.organization_id=t.organization_id
    JOIN agents_platform.agents a ON a.id=v.agent_id AND a.organization_id=t.organization_id
    JOIN agents_platform.conversations c ON c.id=t.conversation_id
    WHERE t.product='growth' AND t.organization_id=$2 AND t.principal=$3::jsonb AND c.deleted_at IS NULL
      AND (t.id=$1 OR t.parent_task_id=$1 AND t.root_task_id=$1) ORDER BY t.created_at,t.id`,
  [root.id, root.organization_id, JSON.stringify(root.principal)])).rows;
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
    coalesce((SELECT binding->'definition'->>'providerOperation'
      FROM jsonb_array_elements(coalesce(coalesce(t.effective_configuration,v.configuration)->'productBindings','[]'::jsonb)) binding
      WHERE binding->>'alias'=o.name LIMIT 1),o.name) name,
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
  return projectGrowthRuntime(root, { tasks: visible, operations, aggregate, snapshot, route, timing });
}
