import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import type pg from 'pg';
import { readConfig } from '../src/config.js';
import { installErrorHandler } from '../src/error.js';
import { registerLeadRoutes } from '../src/routes/leads.js';

test('ordinary production configuration does not require an Agents service', () => {
  const config = readConfig({ DATABASE_URL:'postgres://unused',ENVIRONMENT:'production' });
  assert.equal(config.environment,'production');
  assert.equal(config.env.AGENTS_API_URL,undefined);
  assert.doesNotThrow(()=>readConfig({DATABASE_URL:'postgres://unused',ENVIRONMENT:'production',AGENTS_API_URL:'not-a-url'}));
});

test('quote and waitlist endpoints retain validation and persistence without the retired widget', async () => {
  const writes: { text:string; values:unknown[] }[]=[];
  const pool={async query(text:string,values:unknown[]=[]){
    writes.push({text,values});
    if(text.includes('SELECT id FROM "ProductWaitlistEntry"'))return{rows:[{id:'existing-application'}]};
    return{rows:[]};
  }} as unknown as pg.Pool;
  const app=Fastify();installErrorHandler(app);
  await registerLeadRoutes(app,{pool,config:readConfig({DATABASE_URL:'postgres://unused'})},{sendEmail:async()=>{}});
  try {
    const invalid=await app.inject({method:'POST',url:'/api/quote-requests',payload:{email:[]}});
    assert.equal(invalid.statusCode,400);assert.equal(writes.length,0);
    const quote=await app.inject({method:'POST',url:'/api/quote-requests',payload:{businessName:'Shop',contactPerson:'Owner',phone:'+27820000000',email:'OWNER@example.test',businessType:'retail',services:['custom_ai_chatbots']}});
    assert.equal(quote.statusCode,201);
    const insert=writes.find(row=>row.text.includes('INSERT INTO "QuoteRequest"'));
    assert.ok(insert);assert.equal(insert.values[4],'owner@example.test');
    const denied=await app.inject({method:'POST',url:'/api/waitlist',payload:{contactPerson:'Owner',email:'owner@example.test',products:['feature_agents'],contactConsent:false}});
    assert.equal(denied.statusCode,400);
    const waitlist=await app.inject({method:'POST',url:'/api/waitlist',payload:{contactPerson:'Owner',email:'owner@example.test',products:['feature_agents'],contactConsent:true}});
    assert.equal(waitlist.statusCode,201);assert.equal(waitlist.json().id,'existing-application');
    for(const path of ['/api/widget/v1/loader.js','/api/widget/v1/deployments/old','/api/widget/v1/sessions/old/messages'])assert.equal((await app.inject({url:path})).statusCode,404);
  }finally{await app.close();}
});


test('Labs widget requires an explicit current Agents deployment and safe public origin', async () => {
  const {websiteWidgetConfiguration: config}=await import('../../../../apps/labs-site/src/lib/site-config.js');
  const id='f37b4032-35f5-44f9-8a19-adc4f7b2170d';
  assert.equal(config({}),null);
  assert.equal(config({NEXT_PUBLIC_AGENTS_PUBLIC_URL:'https://agents.example.test',NEXT_PUBLIC_AGENTS_WIDGET_DEPLOYMENT_ID:'wdg_old'}),null);
  for(const base of ['https://user:pass@agents.example.test','javascript:alert(1)','https://agents.example.test/path','https://agents.example.test?key=x','http://agents.example.test']){
    assert.equal(config({NODE_ENV:'production',NEXT_PUBLIC_AGENTS_PUBLIC_URL:base,NEXT_PUBLIC_AGENTS_WIDGET_DEPLOYMENT_ID:id}),null);
  }
  assert.equal(config({NODE_ENV:'production',NEXT_PUBLIC_AGENTS_PUBLIC_URL:'https://agents.example.test',NEXT_PUBLIC_AGENTS_WIDGET_DEPLOYMENT_ID:id})?.src,'https://agents.example.test/api/website/'+id+'/widget.js');
  assert.ok(config({NODE_ENV:'development',NEXT_PUBLIC_AGENTS_PUBLIC_URL:'http://localhost:3100',NEXT_PUBLIC_AGENTS_WIDGET_DEPLOYMENT_ID:id}));
});

test('admin cutover keeps support and webhook recovery protected while retired runtime routes disappear',async()=>{
  const {buildApp}=await import('../src/app.js');
  const {registerAdminOperationsRoutes}=await import('../src/routes/admin-operations.js');
  const {registerCommunicationsRoutes}=await import('../src/routes/communications.js');
  let reads=0;
  const pool={query(){reads++;throw Error('Unauthenticated read must not touch the database');}} as unknown as pg.Pool;
  const app=await buildApp({pool,config:readConfig({DATABASE_URL:'postgres://unused',LOG_LEVEL:'silent'})},[registerAdminOperationsRoutes,registerCommunicationsRoutes]);
  try{
    for(const url of ['/api/admin/operations/support-grants','/api/admin/operations/webhooks/deliveries'])assert.equal((await app.inject({url})).statusCode,401);
    for(const url of ['/api/admin/operations/runs','/api/admin/operations/summary','/api/admin/operations/health','/api/admin/operations/commands/old'])assert.equal((await app.inject({url})).statusCode,404);
    assert.equal((await app.inject({method:'POST',url:'/api/webhooks/telegram/old',payload:{}})).statusCode,404);
    assert.equal(reads,0);
  }finally{await app.close();}
});

test('retired widget paths no longer allow arbitrary website origins',async()=>{
  const {buildApp}=await import('../src/app.js');
  const pool={query(){throw Error('CORS check must not read the database');}} as unknown as pg.Pool;
  const app=await buildApp({pool,config:readConfig({DATABASE_URL:'postgres://unused',ENVIRONMENT:'production',FRONTEND_URL:'https://growth.example.test',LOG_LEVEL:'silent'})},[]);
  try{
    const response=await app.inject({method:'OPTIONS',url:'/api/widget/v1/loader.js',headers:{origin:'https://other.example.test','access-control-request-method':'GET'}});
    assert.equal(response.headers['access-control-allow-origin'],undefined);
  }finally{await app.close();}
});
