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
