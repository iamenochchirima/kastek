import type { PoolClient } from 'pg';
import type { CustomerAction, CustomerOverview, CustomerRecord, CustomerSection, CustomerOperationRequest, CustomerOperationReceipt, CustomerOperationPreview } from '@kasitek-labs/contracts';
import { customerActionEnabled, customerOperationDigest } from '@kasitek-labs/server-support/admin-customers';
import type { TenantContext } from './context.js';
import { transaction } from './db.js';
import { missing, TenantError } from './error.js';
import { changeClientStatusInTransaction } from './controllers/clients.js';

export const customerOperationsEnvironment = (context: TenantContext) => ({ ...context.config.env, NODE_ENV: context.config.environment.toLowerCase() === 'production' ? 'production' : context.config.env.NODE_ENV });

const actions = new Set<CustomerAction>(['client.suspend', 'client.resume']);
const titles: Record<string, string> = {
  clients: 'Clients', staff: 'Staff', domains: 'Domains', 'api-keys': 'API keys',
  agents: 'Agency agents', conversations: 'Agency conversations', usage: 'Usage', limits: 'Configured limits',
  plans: 'Plans and entitlements', deployments: 'Shared deployments', operations: 'Operations',
};
const fact = (key: string, label: string, value: unknown) => ({ key, label, value: value == null ? null : String(value) });
const iso = (value: unknown) => value instanceof Date ? value.toISOString() : value == null ? null : String(value);
export async function agencyCustomerExists(db: Pick<PoolClient, 'query'>, id: string) {
  const row = (await db.query('SELECT id,display_name,status FROM workspaces WHERE id=$1', [id])).rows[0];
  if (!row) throw missing('workspace not found');
  return row;
}

export async function agencyCustomerCollection(context: TenantContext, customerId: string, collection: string, page: { limit: number; cursor: string | null }): Promise<CustomerSection> {
  await agencyCustomerExists(context.pool, customerId);
  if (!Object.hasOwn(titles, collection)) throw missing('collection not found');
  const title = titles[collection]!;
  const source = `agency.${({clients:'tenant_clients',staff:'tenant_users',domains:'workspace_domains','api-keys':'workspace_api_keys',agents:'workspace_agents',conversations:'conversations',usage:'workspace_usage_events',limits:'workspace_usage_limits',operations:'admin_customer_operations'} as Record<string,string>)[collection] ?? collection}`;
  if (collection === 'plans' || collection === 'deployments') return { id: collection, title, source, observedAt: null, status: 'unsupported', records: [], nextCursor: null };
  if (collection === 'usage' || collection === 'limits') {
    if (page.cursor) return { id: collection, title, source, observedAt: new Date().toISOString(), status: 'available', records: [], nextCursor: null };
    const row = collection === 'usage' ? (await context.pool.query(`SELECT
      date_trunc('month',NOW()) AT TIME ZONE 'UTC' AS period_start,
      (date_trunc('month',NOW()) + INTERVAL '1 month') AT TIME ZONE 'UTC' AS period_end,
      COALESCE(SUM(quantity) FILTER(WHERE event_type='request'),0)::text AS requests,
      COALESCE(SUM(quantity) FILTER(WHERE event_type='token'),0)::text AS tokens,
      COALESCE(SUM(quantity) FILTER(WHERE event_type='conversation'),0)::text AS conversations
      FROM workspace_usage_events WHERE workspace_id=$1 AND created_at>=date_trunc('month',NOW()) AND created_at<date_trunc('month',NOW())+INTERVAL '1 month'`, [customerId])).rows[0]
      : (await context.pool.query('SELECT requests_per_month AS requests,tokens_per_month AS tokens,conversations_per_month AS conversations FROM workspace_usage_limits WHERE workspace_id=$1', [customerId])).rows[0];
    const period = collection === 'usage' ? `${iso(row.period_start)}/${iso(row.period_end)}` : 'configured monthly';
    return { id: collection, title, source, observedAt: new Date().toISOString(), status: 'available', nextCursor: null, records: [{ id: collection, label: title, state: collection === 'limits' ? 'enforcement_unknown' : 'measured', facts: ['requests', 'tokens', 'conversations'].map(key => ({ ...fact(key, key, row?.[key]), unit: key, period, ...(collection === 'limits' ? {enforced: null} : {}) })) }] };
  }
  const definitions: Record<string, {table:string;columns:string}> = {
    clients: { table: 'tenant_clients', columns: 'id,status,updated_at' },
    staff: { table: 'tenant_users', columns: 'id,status,last_login_at' },
    domains: { table: 'workspace_domains', columns: 'id,dns_status,verified_at,is_primary' },
    'api-keys': { table: 'workspace_api_keys', columns: 'id,revoked_at,expires_at,last_used_at' },
    agents: { table: 'workspace_agents', columns: 'id,status,updated_at' },
    conversations: { table: 'conversations', columns: 'id,status,channel,tenant_client_id,last_message_at' },
    operations: { table: 'admin_customer_operations', columns: 'id,status,action,target_id,created_at,code' },
  };
  const def = definitions[collection]!;
  const rows = (await context.pool.query(`SELECT ${def.columns} FROM ${def.table} WHERE workspace_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT $3`, [customerId, page.cursor, page.limit + 1])).rows;
  const records: CustomerRecord[] = rows.slice(0, page.limit).map(row => {
    let state = row.status ?? row.dns_status;
    if (collection === 'api-keys') state = row.revoked_at ? 'revoked' : row.expires_at && new Date(row.expires_at).getTime() <= Date.now() ? 'expired' : 'active';
    const record: CustomerRecord = { id: row.id, label: `${collection === 'clients' ? 'Client' : collection === 'staff' ? 'Staff' : collection === 'domains' ? 'Domain' : collection === 'api-keys' ? 'Key' : collection === 'agents' ? 'Agent' : collection === 'operations' ? 'Operation' : 'Conversation'} ${row.id}`, state, facts: Object.entries(row).filter(([key]) => !['id','status','dns_status'].includes(key)).map(([key,value]) => fact(key,key,value instanceof Date ? iso(value) : value)) };
    if (collection === 'clients' && ['active','suspended'].includes(state)) {
      const action = state === 'active' ? 'client.suspend' : 'client.resume';
      if (customerActionEnabled(action, customerOperationsEnvironment(context))) record.actions = [{action, label: state === 'active' ? 'Suspend client' : 'Resume client', targetId: row.id, expected: { state }}];
    }
    return record;
  });
  return {id:collection,title,source,observedAt:new Date().toISOString(),status:'available',records,nextCursor:rows.length > page.limit ? records.at(-1)!.id : null};
}

export async function agencyCustomerOverview(context: TenantContext, id: string): Promise<CustomerOverview> {
  const workspace = await agencyCustomerExists(context.pool, id);
  const sections: CustomerSection[] = [];
  for (const collection of Object.keys(titles)) {
    try { sections.push(await agencyCustomerCollection(context,id,collection,{limit:50,cursor:null})); }
    catch { sections.push({id:collection,title:titles[collection]!,source:`agency.${collection}`,observedAt:null,status:'unavailable',records:[],nextCursor:null}); }
  }
  return { customer:{product:'agency',id,name:workspace.display_name,state:workspace.status}, observedAt:new Date().toISOString(), sections, relationships:[] };
}

function assertAction(context: TenantContext, command: CustomerOperationRequest) {
  if (!actions.has(command.action)) throw new TenantError(400,'unsupported_action');
  if (!customerActionEnabled(command.action,customerOperationsEnvironment(context))) throw new TenantError(403,'action_disabled');
  if (Object.keys(command.expected).length !== 1 || typeof command.expected.state !== 'string' || command.selection !== undefined) throw new TenantError(400,'invalid_precondition');
}
async function eligibility(db: Pick<PoolClient,'query'>, customerId: string, command: CustomerOperationRequest, lock=false) {
  const row=(await db.query(`SELECT status FROM tenant_clients WHERE workspace_id=$1 AND id=$2${lock?' FOR UPDATE':''}`,[customerId,command.targetId])).rows[0];
  if (!row) return 'target_not_found';
  const source=command.action==='client.suspend'?'active':'suspended';
  return row.status !== source || command.expected.state !== row.status ? 'state_conflict' : null;
}
export async function previewAgencyCustomerOperation(context: TenantContext, customerId:string, command:CustomerOperationRequest):Promise<CustomerOperationPreview> {
  assertAction(context,command); await agencyCustomerExists(context.pool,customerId);
  const code=await eligibility(context.pool,customerId,command);
  return {customer:{product:'agency',id:customerId},action:command.action,targetId:command.targetId,impact:command.action==='client.suspend'?'Suspend client access in this workspace':'Restore suspended client access in this workspace',eligible:!code,...(code?{code}:{})};
}
function receipt(row: Record<string,any>):CustomerOperationReceipt {
  return {id:row.id,customer:{product:'agency',id:row.workspace_id},action:row.action,targetId:row.target_id,actorId:row.actor_id,reason:row.reason,status:row.status,code:row.code,createdAt:iso(row.created_at)!,updatedAt:iso(row.updated_at)!};
}
export async function readAgencyCustomerOperation(context:TenantContext, customerId:string, id:string):Promise<CustomerOperationReceipt> {
  const row=(await context.pool.query('SELECT * FROM admin_customer_operations WHERE workspace_id=$1 AND id=$2',[customerId,id])).rows[0];
  if(!row)throw missing('operation not found');
  return receipt(row);
}
export async function performAgencyCustomerOperation(context:TenantContext,customerId:string,actorId:string,command:CustomerOperationRequest):Promise<CustomerOperationReceipt> {
  const digest=customerOperationDigest(actorId,'agency',customerId,command);
  return transaction(context.pool,async tx=>{
    // Serialize one operation ID, including concurrent requests before the first insert.
    await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[command.operationId]);
    const previous=(await tx.query('SELECT * FROM admin_customer_operations WHERE id=$1',[command.operationId])).rows[0];
    if(previous){
      if(previous.request_digest!==digest||previous.workspace_id!==customerId)throw new TenantError(409,'operation_conflict');
      return receipt(previous);
    }
    assertAction(context,command);
    await agencyCustomerExists(tx,customerId);
    const code=await eligibility(tx,customerId,command,true);
    if(!code)await changeClientStatusInTransaction(tx,customerId,command.targetId,command.action==='client.suspend'?'suspended':'active');
    const row=(await tx.query(`INSERT INTO admin_customer_operations(id,workspace_id,target_id,action,actor_id,reason,request_digest,status,code)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,[command.operationId,customerId,command.targetId,command.action,actorId,command.reason,digest,code?'rejected':'confirmed',code])).rows[0];
    await tx.query(`INSERT INTO audit_logs(id,workspace_id,actor_type,actor_id,action,entity_type,entity_id,metadata)
      VALUES($1,$2,'platform_admin',$3,$4,'tenant_client',$5,$6::jsonb)`,[`customer_op_${command.operationId}`,customerId,actorId,command.action,command.targetId,JSON.stringify({operationId:command.operationId,status:row.status,code:row.code})]);
    return receipt(row);
  });
}
