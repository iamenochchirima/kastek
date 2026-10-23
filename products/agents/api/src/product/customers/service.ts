import type {Pool,PoolClient} from "pg";
import type {CustomerOperationRequest,CustomerOperationReceipt,CustomerOperationPreview,CustomerOverview,CustomerSection,CustomerRecord} from "@kasitek-labs/contracts";
import {customerOperationDigest,customerActionEnabled} from "@kasitek-labs/server-support/admin-customers";
import {transaction} from "../../infrastructure/database";
import {requestTreeCancellationInTransaction} from "../../execution/lifecycle/execution";
import {PlatformError,terminalTaskStates} from "../../contracts/contracts";
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function customerUuid(value:string):string {if(!uuid.test(value))throw new PlatformError("INVALID_ID",400,"Invalid resource ID");return value;}
const fail=(code:string,message:string):never=>{throw new PlatformError(code,409,message);};
const terminalSql="'completed','incomplete','refused','failed','cancelled','uncertain'";
type Db=Pool|PoolClient;
const fact=(key:string,label:string,value:unknown)=>({key,label,value:value==null?null:String(value)});
export class AgentsCustomerOperations {
 constructor(readonly pool:Pool,readonly environment:NodeJS.ProcessEnv=process.env){}
 async customer(db:Db,id:string,lock=false){
  customerUuid(id);
  const row=(await db.query(`SELECT id,name FROM agents_platform.organizations WHERE id=$1 ${lock?'FOR UPDATE':''}`,[id])).rows[0];
  if(!row)throw new PlatformError("CUSTOMER_NOT_FOUND",404,"Customer not found");
  return row;
 }
 async section(id:string,collection:string,limit=50,cursor:string|null=null,db:Db=this.pool):Promise<CustomerSection>{
  await this.customer(db,id);
  if(cursor&&!uuid.test(cursor)&&collection!=='operations'&&collection!=='deployments')throw new PlatformError("INVALID_CURSOR",400,"Invalid cursor");
  const args:unknown[]=[id,cursor,limit+1]; let sql:string;
  if(collection==='deployments'){
   const match=cursor?.match(/^(channel|website):([0-9a-f-]{36})$/i);
   if(cursor&&(!match||!uuid.test(match[2]!)))throw new PlatformError('INVALID_CURSOR',400,'Invalid cursor');
   args[1]=match?.[2]??null;args.push(match?.[1]??'');
  }
  switch(collection){
   case 'agents':sql=`SELECT id,name AS label,'configured' AS state,draft_revision::text AS revision FROM agents_platform.agents WHERE organization_id=$1 AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`;break;
   case 'tasks':case 'failures':sql=`SELECT id,id::text AS label,state,control_generation::text AS generation,root_task_id::text AS root_id,parent_task_id::text AS parent_id,product,version_id::text AS version_id,disposition FROM agents_platform.tasks WHERE organization_id=$1 AND evaluation_trial_id IS NULL ${collection==='failures'?"AND state IN ('failed','uncertain','refused','incomplete')":''} AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`;break;
   case 'channels':sql=`SELECT id,name AS label,state,kind,revision::text AS revision FROM agents_platform.channel_connections c WHERE organization_id=$1 AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels e JOIN agents_platform.channel_deployments d ON d.id=e.deployment_id WHERE d.connection_id=c.id) AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`;break;
   case 'deployments':sql=`SELECT * FROM (SELECT id,agent_id::text AS label,state,revision::text AS revision,connection_id::text AS connection_id,'channel' AS kind FROM agents_platform.channel_deployments d WHERE organization_id=$1 AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels e WHERE e.deployment_id=d.id) UNION ALL SELECT id,agent_id::text AS label,CASE WHEN revoked_at IS NULL THEN 'active' ELSE 'revoked' END AS state,NULL::text AS revision,NULL::text AS connection_id,'website' AS kind FROM agents_platform.website_deployments w WHERE organization_id=$1 AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_channels e WHERE e.deployment_id=w.id)) deployment WHERE ($2::uuid IS NULL OR (id,kind)>($2::uuid,$4::text)) ORDER BY id,kind LIMIT $3`;break;
   case 'ingress':sql=`SELECT i.id,i.id::text AS label,i.state,i.connection_id::text AS connection_id,i.attempts::text AS attempts,c.revision::text AS revision,c.state AS connection_state FROM agents_platform.channel_ingress i JOIN agents_platform.channel_connections c ON c.id=i.connection_id AND c.organization_id=i.organization_id WHERE i.organization_id=$1 AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels e WHERE e.deployment_id=i.deployment_id) AND i.state='quarantined' AND ($2::uuid IS NULL OR i.id>$2::uuid) ORDER BY i.id LIMIT $3`;break;
   case 'operations':sql=`SELECT id,action AS label,status AS state,actor_id,created_at::text,code FROM agents_platform.admin_customer_operations WHERE organization_id=$1 AND ($2::text IS NULL OR id>$2) ORDER BY id LIMIT $3`;break;
   case 'usage':{
    const rows=(await db.query(`SELECT day::text,token_allowance::text,reserved_tokens::text,consumed_tokens::text FROM agents_platform.usage_accounts WHERE organization_id=$1 AND day=(now() AT TIME ZONE 'UTC')::date`,[id])).rows;
    return {id:collection,title:'Execution quota',source:'agents',observedAt:rows.length?new Date().toISOString():null,status:rows.length?'available':'unavailable',records:rows.map(r=>({id:r.day,label:r.day,state:'measured',facts:['token_allowance','reserved_tokens','consumed_tokens'].map(key=>({...fact(key,key.replaceAll('_',' '),r[key]),unit:'tokens',period:r.day,enforced:true}))})),nextCursor:null};
   }
   default:throw new PlatformError("COLLECTION_NOT_FOUND",404,"Collection not found");
  }
  const rows=(await db.query(sql,args)).rows,more=rows.length>limit;
  const records:CustomerRecord[]=rows.slice(0,limit).map(r=>{
   const {id:recordId,label,state,...values}=r;
   const record:CustomerRecord={id:collection==='deployments'?`${r.kind}:${recordId}`:recordId,label,state,facts:Object.entries(values).filter(([key])=>!['parent_id','connection_state'].includes(key)).map(([key,value])=>fact(key,key.replaceAll('_',' '),value))};
   if(collection==='tasks'&&!r.parent_id&&!terminalTaskStates.has(state)&&state!=='cancel_requested'&&customerActionEnabled('task.cancel',this.environment))record.actions=[{action:'task.cancel',label:'Request cancellation',targetId:recordId,expected:{state,generation:r.generation}}];
   if(collection==='ingress'&&r.connection_state==='active'&&customerActionEnabled('ingress.retry',this.environment))record.actions=[{action:'ingress.retry',label:'Retry ingress',targetId:r.connection_id,expected:{revision:r.revision},selection:[recordId]}];
   return record;
  });
  return {id:collection,title:collection,source:'agents',observedAt:new Date().toISOString(),status:'available',records,nextCursor:more?records.at(-1)!.id:null};
 }
 async relationships(product:string,customerId:string){
  if(!['growth','agency'].includes(product)||!customerId||customerId.length>256)throw new PlatformError('INVALID_CUSTOMER',400,'Invalid product customer');
  const rows=(await this.pool.query(`SELECT product,tenant_id,organization_id::text,revoked_at FROM agents_platform.product_execution_tenants WHERE product=$1 AND tenant_id=$2 AND issuer<>'' AND client_id<>''`,[product==='agency'?'agencies':product,customerId])).rows;
  return {relationships:rows.map(row=>({product:product as 'growth'|'agency',customerId:row.tenant_id,executionOrganizationId:row.organization_id,mappingId:`${row.product}:${row.tenant_id}`,state:row.revoked_at?'revoked' as const:'active' as const}))};
 }
 async overview(id:string):Promise<CustomerOverview>{
  const row=await this.customer(this.pool,id);
  const mappings=(await this.pool.query(`SELECT product,tenant_id,organization_id::text,client_id,issuer,revoked_at FROM agents_platform.product_execution_tenants WHERE organization_id=$1 AND client_id<>'' AND issuer<>''`,[id])).rows;
  const sections=await Promise.all(['agents','tasks','failures','channels','deployments','usage','ingress','operations'].map(async collection=>{
   try{return await this.section(id,collection);}catch{return {id:collection,title:collection,source:'agents',observedAt:null,status:'unavailable' as const,records:[],nextCursor:null};}
  }));
  sections.push({id:'plan',title:'Commercial plan',source:'agents',observedAt:null,status:'unsupported',records:[],nextCursor:null});
  return {customer:{product:'agents',id,name:row.name,state:mappings.some(m=>m.revoked_at)?'execution_mapping_revoked':'active'},observedAt:new Date().toISOString(),sections,relationships:mappings.map(m=>({product:m.product==='agencies'?'agency':'growth',customerId:m.tenant_id,executionOrganizationId:m.organization_id,mappingId:`${m.product}:${m.tenant_id}`,state:m.revoked_at?'revoked':'active'}))};
 }
 async validate(db:PoolClient,id:string,request:CustomerOperationRequest){
  await this.customer(db,id,true);
  if(!customerActionEnabled(request.action,this.environment))fail('ACTION_DISABLED','Action is disabled');
  const revoked=await db.query(`SELECT product,client_id,issuer,revoked_at FROM agents_platform.product_execution_tenants WHERE organization_id=$1 FOR SHARE`,[id]);
  if(revoked.rows.some(row=>row.revoked_at))fail('MAPPING_REVOKED','Execution mapping revoked');
  customerUuid(request.targetId);
  if(request.action==='task.cancel'){
   if(Object.keys(request.expected).sort().join(',')!=='generation,state')fail('INVALID_EXPECTED','Task state and generation required');
   const task=(await db.query(`SELECT id,state,product,caller_client_id,control_generation::text,parent_task_id,root_task_id FROM agents_platform.tasks WHERE organization_id=$1 AND id=$2 AND evaluation_trial_id IS NULL FOR UPDATE`,[id,request.targetId])).rows[0];
   if(!task)fail('TARGET_NOT_FOUND','Task not found in customer');
   if(task.product!=='agents'&&!revoked.rows.some(mapping=>mapping.product===task.product&&mapping.client_id===task.caller_client_id&&mapping.issuer&&!mapping.revoked_at))fail('MAPPING_ABSENT','Verified execution mapping is unavailable');
   if(task.parent_task_id||task.root_task_id!==task.id)fail('ROOT_REQUIRED','Select the root task');
   if(terminalTaskStates.has(task.state)||task.state==='cancel_requested'||task.state!==request.expected.state||task.control_generation!==String(request.expected.generation))fail('STALE_STATE','Task changed');
   const unsupported=await db.query('SELECT 1 FROM agents_platform.tasks WHERE root_task_id=$1 AND (depth>1 OR organization_id<>$2) LIMIT 1',[task.id,id]);
   if(unsupported.rowCount)fail('UNSUPPORTED_TREE','Unsupported task tree');
   return 'Request cancellation of the active root and its direct children. Runtime settlement and cleanup remain pending.';
  }
  if(request.action==='ingress.retry'){
   if(Object.keys(request.expected).join(',')!=='revision'||!request.selection?.length||request.selection.length>100)fail('INVALID_EXPECTED','Connection revision and selected ingress required');
   request.selection!.forEach(customerUuid);
   const connection=(await db.query(`SELECT revision,state FROM agents_platform.channel_connections c WHERE organization_id=$1 AND id=$2 AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels e JOIN agents_platform.channel_deployments d ON d.id=e.deployment_id WHERE d.connection_id=c.id) FOR SHARE`,[id,request.targetId])).rows[0];
   if(!connection||connection.state!=='active'||String(connection.revision)!==String(request.expected.revision))fail('STALE_STATE','Active connection changed');
   const rows=(await db.query(`SELECT i.id FROM agents_platform.channel_ingress i JOIN agents_platform.channel_deployments d ON d.organization_id=i.organization_id AND d.id=i.deployment_id AND d.connection_id=i.connection_id WHERE i.organization_id=$1 AND i.connection_id=$2 AND i.id=ANY($3::uuid[]) AND i.state='quarantined' AND d.state='active' AND NOT EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels e WHERE e.deployment_id=i.deployment_id) FOR UPDATE OF i FOR SHARE OF d`,[id,request.targetId,request.selection])).rows;
   if(rows.length!==request.selection!.length)fail('STALE_STATE','Selected ingress or deployment changed');
   return `Queue ${rows.length} selected ingress records through normal duplicate prevention. No outbound messages are replayed.`;
  }
  return fail('ACTION_UNSUPPORTED','Action is unavailable for Agents');
 }
 async preview(id:string,request:CustomerOperationRequest):Promise<CustomerOperationPreview>{
  return transaction(this.pool,async db=>({customer:{product:'agents',id},action:request.action,targetId:request.targetId,impact:await this.validate(db,id,request),eligible:true}));
 }
 receipt(row:any):CustomerOperationReceipt{return {id:row.id,customer:{product:'agents',id:row.organization_id},action:row.action,targetId:row.target_id,actorId:row.actor_id,reason:row.reason,status:row.status,createdAt:new Date(row.created_at).toISOString(),updatedAt:new Date(row.updated_at).toISOString(),code:row.code};}
 async execute(id:string,actorId:string,request:CustomerOperationRequest){
  if(!['task.cancel','ingress.retry'].includes(request.action))fail('ACTION_UNSUPPORTED','Action is unavailable for Agents');
  const digest=customerOperationDigest(actorId,'agents',id,request);
  return transaction(this.pool,async db=>{
   await this.customer(db,id,true);
   await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[request.operationId]);
   const existing=(await db.query('SELECT * FROM agents_platform.admin_customer_operations WHERE id=$1 FOR UPDATE',[request.operationId])).rows[0];
   if(existing){if(existing.organization_id!==id||existing.request_digest!==digest)fail('OPERATION_CONFLICT','Operation ID already used');return this.receipt(existing);}
   await db.query(`INSERT INTO agents_platform.admin_customer_operations(id,organization_id,action,target_id,actor_id,reason,request_digest,request,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,[request.operationId,id,request.action,customerUuid(request.targetId),actorId,request.reason,digest,JSON.stringify(request)]);
   try{
    await this.validate(db,id,request);
    if(request.action==='task.cancel')await requestTreeCancellationInTransaction(db,request.targetId);
    else await db.query(`UPDATE agents_platform.channel_ingress SET state='pending',attempts=0,available_at=now(),reason='admin_retry',claim_id=NULL,lease_until=NULL WHERE organization_id=$1 AND connection_id=$2 AND id=ANY($3::uuid[])`,[id,request.targetId,request.selection]);
   }catch(error){
    if(!(error instanceof PlatformError))throw error;
    await db.query(`UPDATE agents_platform.admin_customer_operations SET status='rejected',code=$2,updated_at=now() WHERE id=$1`,[request.operationId,error.code]);
   }
   return this.receipt((await db.query('SELECT * FROM agents_platform.admin_customer_operations WHERE id=$1',[request.operationId])).rows[0]);
  });
 }
 async lookup(id:string,operationId:string){
  return transaction(this.pool,async db=>{
   await this.customer(db,id);
   const row=(await db.query(`SELECT * FROM agents_platform.admin_customer_operations WHERE organization_id=$1 AND id=$2 FOR UPDATE`,[id,operationId])).rows[0];
   if(!row)throw new PlatformError('OPERATION_NOT_FOUND',404,'Operation not found');
   if(row.status==='pending'){
    let settled=false,code:string|null=null;
    if(row.action==='task.cancel'){
     const tasks=(await db.query('SELECT state,disposition FROM agents_platform.tasks WHERE organization_id=$1 AND root_task_id=$2',[id,row.target_id])).rows;
     settled=tasks.length>0&&tasks.every(t=>terminalTaskStates.has(t.state)&&t.disposition==='settled');
     if(settled&&tasks.some(t=>t.state==='uncertain'))code='TASK_EFFECT_UNCERTAIN';
    }else{
     const selected=row.request.selection;
     const ingress=(await db.query('SELECT state FROM agents_platform.channel_ingress WHERE organization_id=$1 AND connection_id=$2 AND id=ANY($3::uuid[])',[id,row.target_id,selected])).rows;
     settled=ingress.length===selected.length&&ingress.every(i=>i.state==='completed');
     if(ingress.some(i=>i.state==='quarantined'))code='INGRESS_REQUARANTINED';
    }
    if(settled||code)Object.assign(row,(await db.query(`UPDATE agents_platform.admin_customer_operations SET status=$2,code=$3,updated_at=now() WHERE id=$1 RETURNING *`,[row.id,code==='TASK_EFFECT_UNCERTAIN'?'unknown':code?'failed':'confirmed',code])).rows[0]);
   }
   return this.receipt(row);
  });
 }
}
