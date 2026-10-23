import type { Pool } from "pg";
import { ADMIN_REPORT_METRICS, type AdminProductReport, type AdminReportQuery, type AdminReportMetric } from "@kasitek-labs/contracts";
import { adminReportSnapshot, reportMetric } from "@kasitek-labs/server-support/admin-reporting";
const terminal = "'completed','incomplete','refused','failed','cancelled','uncertain'";
/** Consumer identity comes from admission's verified product mapping. */
const scoped = `SELECT t.*, CASE t.product WHEN 'agencies' THEN 'agency' ELSE t.product END AS consumer,
 CASE WHEN t.product='agents' THEN t.organization_id::text ELSE p.tenant_id END AS consumer_organization
 FROM agents_platform.tasks t LEFT JOIN agents_platform.product_execution_tenants p
 ON p.organization_id=t.organization_id AND p.product=t.product
 WHERE t.evaluation_trial_id IS NULL
 AND ($4::text IS NULL OR CASE t.product WHEN 'agencies' THEN 'agency' ELSE t.product END=$4)
 AND ($3::text IS NULL OR CASE WHEN t.product='agents' THEN t.organization_id::text ELSE p.tenant_id END=$3)`;
const safeCustomerConversations = `SELECT c.* FROM agents_platform.customer_conversations c
 WHERE ($3::text IS NULL OR c.organization_id::text=$3)
 AND NOT EXISTS(SELECT 1 FROM agents_platform.product_execution_tenants p WHERE p.organization_id=c.organization_id)
 AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_channels e WHERE e.session_id=c.session_id)
 AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels e WHERE e.deployment_id=c.channel_deployment_id)`;
const iso = (value: Date | string | null | undefined) => value ? new Date(value).toISOString() : null;
export async function agentsAdminReport(pool: Pool, q: AdminReportQuery): Promise<AdminProductReport> {
 return adminReportSnapshot(pool, async db => {
  const args = [q.start, q.end, q.organizationId ?? null, q.consumer ?? null];
  const row = (await db.query(`WITH scoped AS (${scoped}) SELECT
   count(*) FILTER(WHERE parent_task_id IS NULL AND created_at>=$1 AND created_at<$2)::text AS runs,
   count(*) FILTER(WHERE parent_task_id IS NOT NULL AND created_at>=$1 AND created_at<$2)::text AS child_tasks,
   count(*) FILTER(WHERE parent_task_id IS NULL AND created_at>=$1 AND created_at<$2 AND state='failed')::text AS failed,
   count(*) FILTER(WHERE parent_task_id IS NULL AND created_at>=$1 AND created_at<$2 AND state='completed')::text AS completed,
   count(*) FILTER(WHERE parent_task_id IS NULL AND state NOT IN (${terminal}))::text AS backlog,
   coalesce(extract(epoch FROM (now()-min(created_at) FILTER(WHERE parent_task_id IS NULL AND state NOT IN (${terminal}))))*1000,0)::bigint::text AS oldest_backlog_ms,
   count(DISTINCT (consumer,consumer_organization)) FILTER(WHERE consumer_organization IS NOT NULL AND created_at>=$1 AND created_at<$2)::text AS active_organizations,
   count(DISTINCT (principal->>'issuer',principal->>'subject')) FILTER(WHERE principal->>'kind'='human' AND principal->>'issuer' IS NOT NULL AND principal->>'subject' IS NOT NULL AND created_at>=$1 AND created_at<$2)::text AS active_users,
   max(updated_at) AS observed FROM scoped`, args)).rows[0];
  const observed = iso(row.observed);
  const metrics: AdminReportMetric[] = Object.entries(row).filter(([key]) => key !== "observed").map(([key, value]) => reportMetric(key, String(value), "agents.tasks", observed));
  const states = (await db.query(`WITH scoped AS (${scoped}) SELECT state,count(*)::text AS value,max(updated_at) AS observed FROM scoped WHERE parent_task_id IS NULL AND created_at>=$1 AND created_at<$2 GROUP BY state ORDER BY state`, args)).rows;
  for (const state of states) metrics.push(reportMetric("task_states", state.value, "agents.tasks", iso(state.observed), {dimensions:{state:state.state}}));
  const latency = (await db.query(`WITH scoped AS (${scoped}) SELECT
   ceil(percentile_cont(0.95) WITHIN GROUP(ORDER BY extract(epoch FROM (r.settled_at-s.created_at))*1000))::bigint::text AS value,
   max(r.settled_at) AS observed FROM scoped s JOIN agents_platform.execution_roots r ON r.root_task_id=s.id
   WHERE s.parent_task_id IS NULL AND r.settled_at>=$1 AND r.settled_at<$2`, args)).rows[0];
  metrics.push(reportMetric("run_latency_p95_ms", latency.value, "agents.execution_roots", iso(latency.observed), latency.value===null ? {availability:"unsupported",reason:"No settled root task in the selected period"} : {}));
  const retries = (await db.query(`WITH scoped AS (${scoped}) SELECT coalesce(sum(greatest(o.attempts-1,0)),0)::text AS value,max(o.created_at) AS observed FROM scoped s JOIN agents_platform.task_outbox o ON o.task_id=s.id WHERE o.created_at>=$1 AND o.created_at<$2`, args)).rows[0];
  metrics.push(reportMetric("dispatch_retries", retries.value, "agents.task_outbox", iso(retries.observed)));
  const operations = (await db.query(`WITH scoped AS (${scoped}) SELECT s.consumer,
   coalesce(r.routes->(CASE WHEN o.kind='compaction' THEN 'compaction' ELSE 'primary' END)->'binding'->>'providerId','unknown') AS provider,
   coalesce(r.routes->(CASE WHEN o.kind='compaction' THEN 'compaction' ELSE 'primary' END)->'binding'->>'modelId','unknown') AS model,
   coalesce(sum((o.output->'usage'->>'inputTokens')::bigint) FILTER(WHERE o.output->'usage'->>'observed'='true'),0)::text AS tokens_input,
   coalesce(sum((o.output->'usage'->>'outputTokens')::bigint) FILTER(WHERE o.output->'usage'->>'observed'='true'),0)::text AS tokens_output,
   count(*) FILTER(WHERE o.output->'usage'->>'observed' IS DISTINCT FROM 'true')::text AS unknown_usage,
   max(o.completed_at) AS observed FROM scoped s JOIN agents_platform.operations o ON o.task_id=s.id
   LEFT JOIN agents_platform.task_model_routes r ON r.task_id=s.id
   WHERE o.kind IN ('model','compaction') AND o.completed_at>=$1 AND o.completed_at<$2
   GROUP BY s.consumer,provider,model ORDER BY s.consumer,provider,model LIMIT 101`, args)).rows;
  for (const item of operations.slice(0,100)) for (const key of ["tokens_input","tokens_output"]) metrics.push(reportMetric(key,item[key],"agents.operations",iso(item.observed),
   {dimensions:{consumer:item.consumer,provider:item.provider,model:item.model},...(item.unknown_usage!=="0"||operations.length>100 ? {availability:"partial" as const,reason:"Missing usage or truncated model dimensions"} : {})}));
  if (!operations.length) for (const key of ["tokens_input","tokens_output"]) metrics.push(reportMetric(key,"0","agents.operations",null));
  const costs = (await db.query(`WITH scoped AS (${scoped}) SELECT s.consumer,
   coalesce(r.routes->(CASE WHEN o.kind='compaction' THEN 'compaction' ELSE 'primary' END)->'binding'->>'providerId','unknown') AS provider,
   coalesce(r.routes->(CASE WHEN o.kind='compaction' THEN 'compaction' ELSE 'primary' END)->'binding'->>'modelId','unknown') AS model,
   coalesce(sum(c.actual_micros) FILTER(WHERE c.state='settled'),0)::text AS known,
   count(*) FILTER(WHERE c.state='unknown')::text AS unknown,max(c.settled_at) AS observed
   FROM scoped s JOIN agents_platform.model_cost_reservations c ON c.task_id=s.id
   JOIN agents_platform.operations o ON o.id=c.operation_id AND o.task_id=s.id
   LEFT JOIN agents_platform.task_model_routes r ON r.task_id=s.id
   WHERE c.settled_at>=$1 AND c.settled_at<$2 GROUP BY s.consumer,provider,model ORDER BY s.consumer,provider,model LIMIT 101`, args)).rows;
  for (const item of costs.slice(0,100)) {
   const dimensions={consumer:item.consumer,provider:item.provider,model:item.model};
   metrics.push(reportMetric("model_cost",item.known,"agents.model_cost_reservations",iso(item.observed),{currency:"USD",dimensions:{...dimensions,exactness:"usage_estimate"},...(item.unknown!=="0"||costs.length>100?{availability:"partial" as const,reason:"Missing model cost or truncated model dimensions"}:{})}));
   metrics.push(reportMetric("unknown_model_operations",item.unknown,"agents.model_cost_reservations",iso(item.observed),{dimensions,...(costs.length>100?{availability:"partial" as const,reason:"Truncated model dimensions"}:{})}));
  }
  if (!costs.length) {
   metrics.push(reportMetric("model_cost","0","agents.model_cost_reservations",null,{currency:"USD",dimensions:{exactness:"usage_estimate"}}));
   metrics.push(reportMetric("unknown_model_operations","0","agents.model_cost_reservations",null));
  }
  if (!q.consumer || q.consumer === 'agents') {
   const channelConnections=(await db.query(`SELECT kind AS channel,state,count(*)::text AS value,max(updated_at) AS observed FROM agents_platform.channel_connections c WHERE ($1::text IS NULL OR organization_id::text=$1) AND NOT EXISTS(SELECT 1 FROM agents_platform.product_execution_tenants p WHERE p.organization_id=c.organization_id) AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels e JOIN agents_platform.channel_deployments d ON d.id=e.deployment_id WHERE d.connection_id=c.id) GROUP BY kind,state ORDER BY kind,state`,[q.organizationId??null])).rows;
   for(const item of channelConnections)metrics.push(reportMetric("connections",item.value,"agents.channel_connections",iso(item.observed),{dimensions:{channel:item.channel,state:item.state}}));
   if(!channelConnections.length)metrics.push(reportMetric("connections","0","agents.channel_connections",null));
   const standalone = (await db.query(`SELECT
    (SELECT count(*) FROM agents_platform.organizations o WHERE ($1::text IS NULL OR o.id::text=$1) AND NOT EXISTS(SELECT 1 FROM agents_platform.product_execution_tenants p WHERE p.organization_id=o.id))::text AS organizations,
    (SELECT count(*) FROM agents_platform.memberships m WHERE m.revoked_at IS NULL AND ($1::text IS NULL OR m.organization_id::text=$1) AND NOT EXISTS(SELECT 1 FROM agents_platform.product_execution_tenants p WHERE p.organization_id=m.organization_id))::text AS memberships,
    (SELECT count(*) FROM agents_platform.agents a WHERE a.created_by IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agents_platform.product_execution_tenants p WHERE p.organization_id=a.organization_id) AND ($1::text IS NULL OR a.organization_id::text=$1))::text AS agents`,[q.organizationId??null])).rows[0];
   for (const [key,value] of Object.entries(standalone)) metrics.push(reportMetric(key,String(value),"agents.standalone_records",null));
   const conversations = (await db.query(`SELECT count(*)::text AS value,max(c.created_at) AS observed FROM agents_platform.conversations c JOIN agents_platform.agents a ON a.id=c.agent_id WHERE a.created_by IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agents_platform.product_execution_tenants p WHERE p.organization_id=a.organization_id) AND ($3::text IS NULL OR c.organization_id::text=$3) AND c.created_at>=$1 AND c.created_at<$2 AND NOT EXISTS(SELECT 1 FROM agents_platform.tasks t WHERE t.conversation_id=c.id AND t.evaluation_trial_id IS NOT NULL)`,args.slice(0,3))).rows[0];
   metrics.push(reportMetric("conversations",conversations.value,"agents.conversations",iso(conversations.observed)));
   const commands = (await db.query(`WITH customer AS (${safeCustomerConversations}) SELECT
    count(*) FILTER(WHERE k.action='takeover')::text AS handoffs,
    count(*) FILTER(WHERE k.action='reply')::text AS human_replies,max(k.created_at) AS observed
    FROM customer c JOIN agents_platform.customer_commands k ON k.conversation_id=c.id WHERE k.created_at>=$1 AND k.created_at<$2`,args.slice(0,3))).rows[0];
   for (const key of ["handoffs","human_replies"]) metrics.push(reportMetric(key,commands[key],"agents.customer_commands",iso(commands.observed)));
   const deliveries = (await db.query(`WITH customer AS (${safeCustomerConversations}) SELECT c.channel_kind AS channel,o.state,count(*)::text AS value,max(o.updated_at) AS observed FROM customer c JOIN agents_platform.channel_outbound o ON o.conversation_id=c.id WHERE o.created_at>=$1 AND o.created_at<$2 GROUP BY c.channel_kind,o.state ORDER BY c.channel_kind,o.state`,args.slice(0,3))).rows;
   for (const item of deliveries) metrics.push(reportMetric("deliveries",item.value,"agents.channel_outbound",iso(item.observed),{dimensions:{channel:item.channel,state:item.state}}));
   const failed = deliveries.filter(item=>item.state==='failed').reduce((sum,item)=>sum+BigInt(item.value),0n).toString();
   metrics.push(reportMetric("delivery_failures",failed,"agents.channel_outbound",null));
   if (!deliveries.length) metrics.push(reportMetric("deliveries","0","agents.channel_outbound",null));
  }
  for (const definition of ADMIN_REPORT_METRICS) if (!metrics.some(metric=>metric.key===definition.key)) metrics.push(reportMetric(definition.key,null,"agents",null,{reason:"No authoritative measurement in this source"}));
  const records = (await db.query(`WITH scoped AS (${scoped}) SELECT id,root_task_id,consumer,consumer_organization,state,created_at FROM scoped WHERE created_at>=$1 AND created_at<$2 ORDER BY created_at DESC,id LIMIT $5 OFFSET $6`,[...args,q.pageSize+1,(q.page-1)*q.pageSize])).rows;
  const timestamps=metrics.map(metric=>metric.observedAt).filter((value):value is string=>value!==null).sort();
  return {contractVersion:"1",product:"agents",query:q,generatedAt:new Date().toISOString(),sourceObservedAt:timestamps.at(-1)??null,completeThrough:null,availability:"partial",metrics,
   records:records.slice(0,q.pageSize).map(item=>({id:item.id,rootId:item.root_task_id,consumer:item.consumer,organizationId:item.consumer_organization??"unallocated",kind:"task",state:item.state,occurredAt:iso(item.created_at)!})),hasMore:records.length>q.pageSize};
 });
}
