import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {claimSend,completeSend} from '../src/services/admin/outreach-send.js';
import {getInvoice,listInvoices,invoiceRunAction} from '../src/services/admin/invoices.js';

const url=process.env.CORE_COMMERCIAL_TEST_DATABASE_URL;
async function fixture(run:(pool:pg.Pool)=>Promise<void>) {
  const schema=`commercial_${randomUUID().replaceAll('-','')}`;
  const connection=new pg.Pool({connectionString:url});
  await connection.query(`CREATE SCHEMA "${schema}"`);
  const pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  try {
    await pool.query('CREATE TABLE "OutreachLead" (id TEXT PRIMARY KEY,"campaignId" TEXT,"emailStatus" TEXT,"emailSentAt" TIMESTAMP,"updatedAt" TIMESTAMP)');
    await pool.query('CREATE TABLE "OutreachEmailDeliveryLog" (id TEXT,"campaignId" TEXT,"leadId" TEXT,recipient TEXT,subject TEXT,status TEXT,provider TEXT,"providerMessageId" TEXT,"attemptedAt" TIMESTAMP,"isTest" BOOLEAN DEFAULT FALSE)');
    await pool.query(readFileSync(fileURLToPath(new URL('../../database/prisma/migrations/20261023095000_admin_commercial_safety/migration.sql',import.meta.url)),'utf8'));
    await pool.query('INSERT INTO "OutreachLead" (id,"campaignId","emailStatus") VALUES (\'lead\',\'campaign\',\'pending\')');
    await run(pool);
  } finally { await pool.end();await connection.query(`DROP SCHEMA "${schema}" CASCADE`);await connection.end(); }
}
test('concurrent claims submit once; uncertainty blocks retry until evidence reconciles it',{skip:!url},async()=>fixture(async pool=>{
  const input={fingerprint:'a'.repeat(64),recipients:['a@example.test','b@example.test'],subject:'Test'};
  const claims=await Promise.allSettled([claimSend(pool,'owner','campaign','lead',input),claimSend(pool,'owner','campaign','lead',input)]);
  assert.equal(claims.filter(v=>v.status==='fulfilled').length,1);
  const attempt=claims.find(v=>v.status==='fulfilled')! as PromiseFulfilledResult<{id:string}>;
  await completeSend(pool,'owner',attempt.value.id,{accepted:[],rejected:[]});
  await assert.rejects(claimSend(pool,'owner','campaign','lead',{...input,fingerprint:'b'.repeat(64)}),/uncertain/);
  await assert.rejects(completeSend(pool,'owner',attempt.value.id,{notSubmitted:true},true),/evidence/);
  await completeSend(pool,'owner',attempt.value.id,{notSubmitted:true,evidence:'Provider audit confirms no submission'},true);
  const retry=await claimSend(pool,'owner','campaign','lead',{...input,retryOf:attempt.value.id});
  const result=await completeSend(pool,'owner',retry.id,{accepted:['a@example.test'],rejected:['b@example.test'],messageId:'test-id'});
  assert.equal(result.status,'partial');
  assert.equal((await pool.query('SELECT "emailStatus" FROM "OutreachLead"')).rows[0].emailStatus,'partial');
  const logs=(await pool.query('SELECT recipient,status FROM "OutreachEmailDeliveryLog" WHERE "providerMessageId"=\'test-id\' ORDER BY recipient')).rows;
  assert.deepEqual(logs,[{recipient:'a@example.test',status:'accepted'},{recipient:'b@example.test',status:'rejected'}]);
}));
test('result persistence failure rolls back and preserves submitting claim',{skip:!url},async()=>fixture(async pool=>{
  const attempt=await claimSend(pool,'owner','campaign','lead',{fingerprint:'c'.repeat(64),recipients:['a@example.test'],subject:'Test'});
  await pool.query('ALTER TABLE "AdminCommercialAudit" ADD CONSTRAINT deny_result CHECK (action <> \'outreach.smtp_result\')');
  await assert.rejects(completeSend(pool,'owner',attempt.id,{accepted:['a@example.test'],rejected:[]}));
  assert.equal((await pool.query('SELECT status FROM "AdminOutreachSendAttempt"')).rows[0].status,'submitting');
  await assert.rejects(claimSend(pool,'owner','campaign','lead',{fingerprint:'d'.repeat(64),recipients:['a@example.test'],subject:'Changed'}),/submitting/);
}));
test('invoice GET queries remain read only including current recurring state',async()=>{
  const invoice={id:'invoice',date:new Date(),billingMode:'monthly',recurringActive:true,billingAnchorDay:1,reminderDaysAfterDue:3,validityDays:14,status:'draft'};
  const queries:string[]=[];
  const pool={query:async(sql:string)=>{queries.push(sql);assert.match(sql,/^SELECT/);return {rows:sql.includes('FROM "Invoice"')?[invoice]:[]};}} as unknown as pg.Pool;
  await getInvoice(pool,'invoice');await listInvoices(pool);
  assert.ok(queries.some(q=>q.includes('"InvoiceRun"')));
});
test('invoice actions rollback bookkeeping if actor audit fails',{skip:!url},async()=>fixture(async pool=>{
  const initial=readFileSync(fileURLToPath(new URL('../../database/prisma/migrations/20260301000000_initial_client_schema/migration.sql',import.meta.url)),'utf8');
  await pool.query(initial.match(/CREATE TABLE "Invoice" \([\s\S]*?\n\);/)![0]);
  await pool.query(readFileSync(fileURLToPath(new URL('../../database/prisma/migrations/20260701103000_add_invoice_recurring_workflow/migration.sql',import.meta.url)),'utf8'));
  await pool.query('INSERT INTO "Invoice" (id,"businessName","contactPerson","contactEmail","contactPhone",date,title,"setupFee","monthlyFee","updatedAt") VALUES (\'invoice\',\'Example\',\'Owner\',\'a@example.test\',\'0\',NOW(),\'Invoice\',\'0\',\'0\',NOW())');
  await pool.query('INSERT INTO "InvoiceRun" (id,"invoiceId","cycleKey","issueDate","periodStart","periodEnd","dueDate","titleSnapshot","contactEmailSnapshot","businessNameSnapshot") VALUES (\'run\',\'invoice\',\'test\',NOW(),NOW(),NOW(),NOW(),\'Invoice\',\'a@example.test\',\'Example\')');
  await pool.query('ALTER TABLE "AdminCommercialAudit" ADD CONSTRAINT deny_invoice CHECK (action <> \'invoice.mark_paid\')');
  await assert.rejects(invoiceRunAction(pool,'invoice','run','mark_paid','owner'));
  assert.equal((await pool.query('SELECT status FROM "Invoice"')).rows[0].status,'draft');
  assert.equal((await pool.query('SELECT status FROM "InvoiceRun"')).rows[0].status,'pending');
  await pool.query('ALTER TABLE "AdminCommercialAudit" DROP CONSTRAINT deny_invoice');
  await invoiceRunAction(pool,'invoice','run','mark_paid','owner');
  assert.equal((await pool.query('SELECT status FROM "Invoice"')).rows[0].status,'paid');
  assert.equal((await pool.query('SELECT "actorId" FROM "AdminCommercialAudit" WHERE action=\'invoice.mark_paid\'')).rows[0].actorId,'owner');
}));

test('partial retry excludes every accepted recipient',{skip:!url},async()=>fixture(async pool=>{
  const input={fingerprint:'e'.repeat(64),recipients:['a@example.test','b@example.test'],subject:'Test'};
  const attempt=await claimSend(pool,'owner','campaign','lead',input);
  await completeSend(pool,'owner',attempt.id,{accepted:['a@example.test'],rejected:['b@example.test']});
  await assert.rejects(claimSend(pool,'owner','campaign','lead',{...input,retryOf:attempt.id}),/only rejected/);
  const retry=await claimSend(pool,'owner','campaign','lead',{...input,recipients:['b@example.test'],retryOf:attempt.id});
  assert.equal(retry.status,'submitting');
}));

test('commercial routes register beside existing admin lead routes',async()=>{
  const {default:fastify}=await import('fastify');
  const {registerAdminOperationsRoutes}=await import('../src/routes/admin-operations.js');
  const app=fastify();
  try {
    registerAdminOperationsRoutes(app,{pool:{} as pg.Pool,config:{env:{}} as never});
    await app.ready();
    assert.equal(app.hasRoute({method:'POST',url:'/api/admin/outreach/:id/leads/:lead_id/send-attempts'}),true);
    assert.equal(app.hasRoute({method:'POST',url:'/api/admin/invoices/:id/materialize'}),true);
  } finally {await app.close();}
});
