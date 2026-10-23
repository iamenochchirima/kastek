import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadOutreachFiles,normalizeDraft} from '../src/lib/outreach-drafts';
import {submitOutreach} from '../src/lib/outreach-submit';
test('nested draft files use the same aliases and normalized values for preview and import',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'outreach-drafts-'));
  try {
    await mkdir(path.join(dir,'category'));
    const camel={businessName:' Example ',website:'example.test',contactEmails:['A@example.test','a@example.test'],subject:' Hello ',emailBody:' Body '};
    await writeFile(path.join(dir,'category','draft.json'),JSON.stringify({leads:[camel]}));
    const files=await loadOutreachFiles(dir);
    assert.equal(files[0].key,path.join('category','draft.json'));
    assert.deepEqual(files[0].leads[0],{...normalizeDraft(camel),source_file:files[0].key});
    assert.deepEqual(files[0].leads[0].contact_emails,['a@example.test']);
  } finally { await rm(dir,{recursive:true,force:true}); }
});
const input={campaignId:'campaign',leadId:'lead',to:['a@example.test'],subject:'Test',text:'Body'};
test('accepted SMTP followed by persistence failure stays uncertain and never resets pending',async()=>{
  const calls:string[]=[];let sent=0;
  const result=await submitOutreach(input,{core:async (route)=>{calls.push(route);return route.endsWith('send-attempts')?Response.json({id:'attempt'}):Response.json({error:'Database failed'},{status:500});},send:async()=>{sent++;return {accepted:input.to,rejected:[],messageId:'message'};}});
  assert.equal(sent,1);assert.equal(result.body.status,'uncertain');assert.equal(result.body.attemptId,'attempt');
  assert.equal(calls.length,2);assert.ok(calls.every(v=>!v.endsWith('/lead')));
});
test('duplicate claim prevents any provider call',async()=>{
  const result=await submitOutreach(input,{core:async()=>Response.json({error:'Attempt uncertain'},{status:409}),send:async()=>{throw new Error('Should never submit');}});
  assert.equal(result.status,409);
});
test('transport error is uncertain and preserves the claim',async()=>{
  const result=await submitOutreach(input,{core:async route=>route.endsWith('send-attempts')?Response.json({id:'attempt'}):Response.json({status:'uncertain'}),send:async()=>{throw new Error('Timeout after DATA');}});
  assert.equal(result.body.status,'uncertain');
});

test('failed draft imports never increase success count and retain per-record errors',async()=>{
  const {applyDraftUpdates}=await import('../src/lib/outreach-import');
  const result=await applyDraftUpdates([{id:'ok'},{id:'rejected'},{id:'network'}],async record=>{if(record.id==='network') throw new Error('Disconnected');return new Response('',{status:record.id==='ok'?200:422});});
  assert.deepEqual(result,{updated:1,failures:[{leadId:'rejected',status:422},{leadId:'network',status:503}]});
});
