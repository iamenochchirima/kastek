import {publicUpdateAssistanceSchema} from "../src/contracts/procedure-tools";
import {describe,expect,it} from "vitest";
import {discoverProcedures,loadProcedure,afterHoursProgress} from "../src/contracts/procedure-definitions";
import {procedureUpdateSchema,type ProcedureReceipt} from "../src/contracts/procedures";
const evidence=(kind:ProcedureReceipt['kind'],status:ProcedureReceipt['status']='confirmed'):ProcedureReceipt=>({kind,status,sourceId:kind});
describe('after-hours procedure contract',()=>{
 it('keeps contact capture separate from an explicit request to stop automation',()=>{
  const base={requestId:crypto.randomUUID(),evidenceMessageId:crypto.randomUUID(),evidenceQuote:'Please save alex@example.test for staff to contact me.'};
  const contact={method:'email',value:'alex@example.test'};
  expect(publicUpdateAssistanceSchema.safeParse({...base,action:'save_contact',contact}).success).toBe(true);
  expect(publicUpdateAssistanceSchema.safeParse({...base,action:'human_only',contact}).success).toBe(false);
  expect(publicUpdateAssistanceSchema.safeParse({...base,action:'save_contact'}).success).toBe(false);
 });
 it('requires delivered facts, a customer route and a durable callback request only when needed',()=>{
  const notices=[evidence('after_hours_notice'),evidence('help_offer'),evidence('customer_choice')];
  expect(afterHoursProgress(null,notices).complete).toBe(false);
  expect(afterHoursProgress('unsupported',notices).complete).toBe(false);
  expect(afterHoursProgress('self_service',notices).complete).toBe(true);
  expect(afterHoursProgress('declined',notices).complete).toBe(true);
  expect(afterHoursProgress('callback',notices).missing).toEqual(['human_request']);
  expect(afterHoursProgress('callback',[...notices,evidence('human_request','unknown')]).complete).toBe(false);
  expect(afterHoursProgress('callback',[...notices,evidence('human_request')]).complete).toBe(true);
 });
 it('does not discover unselected, unavailable, or unready definitions or accept model completion flags',()=>{
  const reference={id:'after-hours-assistance',version:'1'};
  expect(discoverProcedures([],()=>true)).toEqual([]);
  expect(discoverProcedures([reference],()=>false)).toEqual([]);
  expect(discoverProcedures([reference],()=>true)).toHaveLength(1);
  expect(()=>loadProcedure({...reference,version:'2'})).toThrow();
  expect(procedureUpdateSchema.safeParse({action:'complete',commandId:crypto.randomUUID(),expectedRevision:'1'}).success).toBe(false);
 });
});

import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Pool} from 'pg';
import {afterAll,beforeAll} from 'vitest';
import {ProcedureStore} from '../src/execution/procedures/store';
import {dropClosedTestDatabase} from './support/database-cleanup';
const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)('durable procedure store',()=>{
 const database=`agents_procedures_${randomUUID().replaceAll('-','')}`;
 let admin:Pool,pool:Pool,store:ProcedureStore;
 const taskId=randomUUID(),versionId=randomUUID();
 const scope={organizationId:randomUUID(),agentId:randomUUID(),conversationId:randomUUID()};
 beforeAll(async()=>{
  admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);
  const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});
  await pool.query(`CREATE SCHEMA agents_platform;CREATE TABLE agents_platform.agents(organization_id uuid,id uuid,PRIMARY KEY(organization_id,id));CREATE TABLE agents_platform.conversations(organization_id uuid,id uuid,agent_id uuid,deleted_at timestamptz,PRIMARY KEY(organization_id,id));CREATE TABLE agents_platform.agent_versions(id uuid PRIMARY KEY,organization_id uuid,agent_id uuid);CREATE TABLE agents_platform.tasks(id uuid PRIMARY KEY,organization_id uuid,conversation_id uuid,version_id uuid,UNIQUE(organization_id,id));`);
  await pool.query(await readFile(join(__dirname,'../schema/116_business_procedures.sql'),'utf8'));
  await pool.query('INSERT INTO agents_platform.agents VALUES($1,$2)',[scope.organizationId,scope.agentId]);
  await pool.query('INSERT INTO agents_platform.conversations VALUES($1,$2,$3,NULL)',[scope.organizationId,scope.conversationId,scope.agentId]);
  await pool.query('INSERT INTO agents_platform.agent_versions VALUES($1,$2,$3)',[versionId,scope.organizationId,scope.agentId]);
  await pool.query('INSERT INTO agents_platform.tasks VALUES($1,$2,$3,$4)',[taskId,scope.organizationId,scope.conversationId,versionId]);
  store=new ProcedureStore(pool,async()=>{});
 });
 afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 it('persists receipt-derived completion, commands and revision guards without cancelling product effects',async()=>{
  const ref={id:'after-hours-assistance',version:'1'},start={taskId,commandId:randomUUID(),applicability:{afterHours:true,nextOpeningAt:null}};
  await expect(store.start(scope,ref,{...start,taskId:randomUUID()})).rejects.toMatchObject({code:'PROCEDURE_ORIGIN_DENIED'});
  const instance=await store.start(scope,ref,start);
  expect((await pool.query('SELECT origin_task_id FROM agents_platform.business_procedure_instances WHERE id=$1',[instance.id])).rows[0].origin_task_id).toBe(taskId);
  expect((await store.start(scope,ref,start)).id).toBe(instance.id);
  expect((await store.start(scope,ref,{...start,commandId:randomUUID()})).id).toBe(instance.id);
  await expect(store.inspect({...scope,agentId:randomUUID()},instance.id)).rejects.toMatchObject({code:'PROCEDURE_NOT_FOUND'});
  let state=await store.recordEvidence(scope,instance.id,{commandId:randomUUID(),expectedRevision:instance.revision,route:'callback',receipts:[evidence('after_hours_notice'),evidence('help_offer'),evidence('customer_choice'),evidence('human_request','unknown')]});
  expect(state.status).toBe('active');expect(state.hasUnknownEffects).toBe(true);
  await expect(store.update(scope,state.id,{commandId:randomUUID(),expectedRevision:'1',action:'cancel'})).rejects.toMatchObject({code:'PROCEDURE_CONFLICT'});
  state=await store.update(scope,state.id,{commandId:randomUUID(),expectedRevision:state.revision,action:'suspend'});
  state=await new ProcedureStore(pool,async()=>{}).update(scope,state.id,{commandId:randomUUID(),expectedRevision:state.revision,action:'resume'});
  state=await store.update(scope,state.id,{commandId:randomUUID(),expectedRevision:state.revision,action:'cancel'});
  expect(state.status).toBe('cancelled');expect(state.receipts).toHaveLength(4);expect(state.hasUnknownEffects).toBe(true);
  state=await store.recordEvidence(scope,state.id,{commandId:randomUUID(),expectedRevision:state.revision,receipts:[evidence('human_request')]});
  expect(state.status).toBe('cancelled');expect(state.hasUnknownEffects).toBe(false);
  const second=await store.start(scope,ref,{...start,commandId:randomUUID()});
  const complete=await store.recordEvidence(scope,second.id,{commandId:randomUUID(),expectedRevision:second.revision,route:'self_service',receipts:[evidence('after_hours_notice'),evidence('help_offer'),evidence('customer_choice')]});
  expect(complete.status).toBe('completed');
  await expect(new ProcedureStore(pool).recordEvidence(scope,second.id,{commandId:randomUUID(),expectedRevision:complete.revision,receipts:[]})).rejects.toMatchObject({code:'PROCEDURE_EVIDENCE_UNAVAILABLE'});
 });
});
