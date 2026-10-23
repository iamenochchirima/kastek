import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { buildApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { runMigrations } from '../src/migrate.js';
import { registerAdminCustomerRoutes } from '../src/controllers/admin-customers.js';
import { createAdminAuthority, ADMIN_AUTHORITY_HEADER } from '@kasitek-labs/server-support/admin-authority';

const url=process.env.ADMIN_CUSTOMERS_TEST_DATABASE_URL;
test('Agency customer operations isolate metadata and atomically bind state, outbox, audit and receipts', {skip:!url},async()=>{
  const base=new pg.Pool({connectionString:url});
  const schema=`agency_customer_${randomUUID().replaceAll('-','')}`;
  await base.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema} -c timezone=UTC`});
  const secret='synthetic-agency-customer-test-secret';
  const env={TENANT_DATABASE_URL:url,KASITEK_ADMIN_SERVICE_SECRET:secret,KASITEK_CUSTOMER_OPERATIONS:'1',KASITEK_CUSTOMER_ACTIONS:'client.suspend,client.resume',LOG_LEVEL:'silent'};
  const context={pool,config:readConfig(env)};
  const app=await buildApp(context,[registerAdminCustomerRoutes]);
  async function request(method:'GET'|'POST',path:string,value?:unknown,role='operator',capability:'admin:read'|'admin:operate'=method==='GET'?'admin:read':'admin:operate') {
    const body=value===undefined?undefined:JSON.stringify(value);
    return app.inject({method,url:path,...(body?{payload:body}:{}),headers:{...(body?{'content-type':'application/json'}:{}),[ADMIN_AUTHORITY_HEADER]:createAdminAuthority({secret,audience:'agency',actor:{id:`actor-${role}`,role},capability,method,path,body})}});
  }
  const customer='/api/admin/customers/workspace-one';
  const make=(id:string,target='client-one',action='client.suspend',state='active')=>({operationId:id,action,label:'ignored',targetId:target,expected:{state},reason:'Customer operations fixture'});
  try {
    await runMigrations(pool);
    await pool.query(`INSERT INTO workspaces(id,slug,display_name,status)VALUES('workspace-one','one','Workspace one','active'),('workspace-two','two','Workspace two','active');
      INSERT INTO tenant_clients(id,workspace_id,name,slug,status,external_ref,metadata) VALUES
      ('client-one','workspace-one','Private client name','one','active','growth-org', '{"secret":"private-client-config"}'),
      ('client-two','workspace-one','Private second name','two','suspended',NULL,'{}'),
      ('client-three','workspace-two','Other customer','three','active',NULL,'{}'),
      ('client-archived','workspace-one','Archived customer','archived','archived',NULL,'{}');
      INSERT INTO tenant_users(id,workspace_id,email,password_hash,status)VALUES('staff-one','workspace-one','private@example.test','private-password','active');
      INSERT INTO workspace_api_keys(id,workspace_id,label,key_prefix,key_hash)VALUES('key-one','workspace-one','private-key-label','secret-prefix','secret-key-hash');
      INSERT INTO workspace_agents(id,workspace_id,name,config)VALUES('agent-one','workspace-one','private-agent-name','{"prompt":"private-prompt"}');
      INSERT INTO conversations(id,workspace_id,channel,customer_identifier,customer_name,metadata)VALUES('conversation-one','workspace-one','web','private@example.test','private-visitor','{"secret":"private-chat"}');
      INSERT INTO workspace_usage_events(id,workspace_id,event_type,quantity)VALUES('usage-one','workspace-one','token',9007199254740993);
      INSERT INTO workspace_usage_limits(workspace_id,requests_per_month,tokens_per_month,conversations_per_month)VALUES('workspace-one',10,20,30)`);
    assert.equal((await app.inject(customer)).statusCode,403);
    for (const role of ['viewer','support','security','operator','owner']) assert.equal((await request('GET',customer,undefined,role)).statusCode,200);
    const overview=await request('GET',customer,undefined,'viewer');assert.equal(overview.statusCode,200,overview.body);
    const data=overview.json();assert.equal(data.customer.id,'workspace-one');assert.deepEqual(data.relationships,[]);
    assert.equal(data.sections.find((s:any)=>s.id==='plans').status,'unsupported');
    assert.equal(data.sections.find((s:any)=>s.id==='deployments').status,'unsupported');
    assert.equal(data.sections.find((s:any)=>s.id==='usage').records[0].facts.find((f:any)=>f.key==='tokens').value,'9007199254740993');
    assert(data.sections.find((s:any)=>s.id==='limits').records[0].facts.every((f:any)=>f.enforced===null));
    for(const text of ['private@example.test','private-password','secret-prefix','secret-key-hash','private-prompt','private-client-config','private-chat','private-visitor','growth-org','Other customer'])assert(!overview.body.includes(text),text);
    const first=await request('GET',customer+'/clients?limit=1');assert.equal(first.statusCode,200);assert.equal(first.json().records.length,1);
    const second=await request('GET',customer+'/clients?limit=1&cursor='+first.json().nextCursor);assert.notEqual(second.json().records[0].id,first.json().records[0].id);
    assert.equal((await request('GET',customer+'/constructor')).statusCode,404);
    assert.equal((await request('GET',customer+'/clients?limit=101')).statusCode,400);
    assert.equal((await request('GET',customer+'/clients?status=active')).statusCode,400);
    const command=make('operation-one');
    for (const role of ['viewer','support','security']) assert.equal((await request('POST',customer+'/operations',command,role,'admin:read')).statusCode,403);
    assert.equal((await request('GET',customer,undefined,'operator','admin:operate')).statusCode,403);
    assert.equal((await request('POST',customer+'/operations/preview',command,'viewer','admin:read')).statusCode,403);
    const preview=await request('POST',customer+'/operations/preview',command);assert.equal(preview.statusCode,200,preview.body);assert.equal(preview.json().eligible,true);
    assert.equal((await pool.query("SELECT status FROM tenant_clients WHERE id='client-one'")).rows[0].status,'active');
    const execute=await request('POST',customer+'/operations',command);assert.equal(execute.statusCode,200,execute.body);assert.equal(execute.json().status,'confirmed');
    assert.equal((await pool.query("SELECT status FROM tenant_clients WHERE id='client-one'")).rows[0].status,'suspended');
    const after=(await pool.query('SELECT (SELECT count(*) FROM analytics_outbox) AS outbox,(SELECT count(*) FROM audit_logs) AS audit')).rows[0];
    assert(BigInt(after.outbox)>0);assert.equal(after.audit,'1');
    assert.deepEqual((await request('POST',customer+'/operations',command)).json(),execute.json());
    assert.deepEqual((await pool.query('SELECT (SELECT count(*) FROM analytics_outbox) AS outbox,(SELECT count(*) FROM audit_logs) AS audit')).rows[0],after);
    assert.equal((await request('POST',customer+'/operations',{...command,reason:'Different operation reason'})).statusCode,409);
    assert.equal((await request('POST',customer+'/operations',command,'owner')).statusCode,409);
    const cross=await request('POST',customer+'/operations',make('operation-cross','client-three'));assert.equal(cross.json().status,'rejected');assert.equal(cross.json().code,'target_not_found');
    const archived=await request('POST',customer+'/operations',make('operation-archived','client-archived'));assert.equal(archived.json().code,'state_conflict');
    const stale=await request('POST',customer+'/operations',make('operation-stale'));assert.equal(stale.json().code,'state_conflict');
    const resume=await request('POST',customer+'/operations',make('operation-resume','client-one','client.resume','suspended'));assert.equal(resume.json().status,'confirmed');
    const concurrent=await Promise.all([request('POST',customer+'/operations',make('operation-race-a')),request('POST',customer+'/operations',make('operation-race-b'))]);
    assert.deepEqual(concurrent.map(r=>r.json().status).sort(),['confirmed','rejected']);
    assert.equal((await request('GET','/api/admin/customers/workspace-two/operations/operation-one')).statusCode,404);
    assert.equal((await request('GET',customer+'/operations/operation-one')).json().status,'confirmed');
    assert.equal((await request('POST',customer+'/operations',{...make('operation-unsafe'),action:'task.cancel'})).statusCode,400);
    // An audit failure must roll back the state change and lifecycle outbox.
    await pool.query(`CREATE FUNCTION reject_customer_audit() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'fixture audit failure'; END$$;
      CREATE TRIGGER reject_customer_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION reject_customer_audit()`);
    const beforeFailure=(await pool.query('SELECT count(*) FROM analytics_outbox')).rows[0].count;
    const fail=await request('POST',customer+'/operations',make('operation-rollback','client-one','client.resume','suspended'));assert.equal(fail.statusCode,500);
    assert.equal((await pool.query("SELECT status FROM tenant_clients WHERE id='client-one'")).rows[0].status,'suspended');
    assert.equal((await pool.query("SELECT count(*) FROM admin_customer_operations WHERE id='operation-rollback'")).rows[0].count,'0');
    assert.equal((await pool.query('SELECT count(*) FROM analytics_outbox')).rows[0].count,beforeFailure);
    await pool.query('DROP TRIGGER reject_customer_audit ON audit_logs');
    context.config.env.KASITEK_CUSTOMER_ACTIONS='';
    assert.equal((await request('POST',customer+'/operations',make('operation-disabled'))).statusCode,403);
    assert.equal((await request('GET',customer+'/operations/operation-one')).statusCode,200);
    assert.equal((await request('POST',customer+'/operations',command)).json().status,'confirmed');
    context.config.env.KASITEK_CUSTOMER_OPERATIONS='0';
    assert.equal((await request('GET',customer)).statusCode,404);
    context.config.env.KASITEK_CUSTOMER_OPERATIONS='1';context.config.environment='production';
    assert.equal((await request('GET',customer)).statusCode,404);
  } finally {
    await app.close();await pool.end();await base.query(`DROP SCHEMA "${schema}" CASCADE`);await base.end();
  }
});
