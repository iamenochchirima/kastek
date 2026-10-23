import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createOperationsServiceAuthority,verifyOperationsServiceAuthority} from '../dist/operations-authority.js';
import {parseOperationsSnapshot,readOperationsSnapshot} from '../dist/operations-signals.js';
const request={secret:'s'.repeat(40),audience:'agents',scope:'signals:read',environment:'development',method:'GET',path:'/internal/operations/signals',now:Date.now()};
test('observer authority is fixed destination scope path body environment and expiry bound',()=>{
 const token=createOperationsServiceAuthority(request);assert.equal(verifyOperationsServiceAuthority(token,request).subject,'operations-observer');
 for(const diff of [{audience:'growth'},{environment:'production'},{path:'/api/admin/customers/id/operations'},{method:'POST'},{body:' '},{now:request.now+30001},{secret:'x'.repeat(40)}])assert.throws(()=>verifyOperationsServiceAuthority(token,{...request,...diff}));
 assert.throws(()=>createOperationsServiceAuthority({...request,scope:'notifications:publish'}));
 const publish={...request,audience:'growth',scope:'notifications:publish',method:'POST',path:'/internal/operations/notifications',body:'{}'};
 assert.equal(verifyOperationsServiceAuthority(createOperationsServiceAuthority(publish),publish).subject,'operations-notifier');
 assert.throws(()=>verifyOperationsServiceAuthority(token,publish));
});
const snapshot={contractVersion:'1',source:'agents',environment:'development',observedAt:new Date().toISOString(),release:'development',signals:[{key:'execution.failure_rate_bps',group:'global',status:'available',value:'2000',denominator:'25',unit:'basis_points',coverage:'complete',evidence:[]}]};
test('source contract preserves unknown and exact rates and strips unapproved fields',()=>{
 const clean=parseOperationsSnapshot({...snapshot,secrets:'private'},'agents','development');assert.equal(clean.signals[0].denominator,'25');assert(!('secrets'in clean));
 for(const diff of [{environment:'production'},{source:'growth'},{observedAt:'yesterday'},{signals:[{...snapshot.signals[0],value:1}]},{signals:[{...snapshot.signals[0],value:'10001'}]},{signals:[{...snapshot.signals[0],group:'customer@example.test'}]},{signals:[...snapshot.signals,...snapshot.signals]}])assert.throws(()=>parseOperationsSnapshot({...snapshot,...diff},'agents','development'));
 const unknown=parseOperationsSnapshot({...snapshot,signals:[{...snapshot.signals[0],status:'unknown',value:null,coverage:'unknown'}]},'agents','development');assert.equal(unknown.signals[0].value,null);
});
test('untrusted HTTP snapshots have a hard byte limit',async()=>{
 await assert.rejects(readOperationsSnapshot(new Response(' '.repeat(65537)),'agents','development'));
 await assert.rejects(readOperationsSnapshot(new Response('{}',{status:403}),'agents','development'));
 const result=await readOperationsSnapshot(Response.json(snapshot),'agents','development');assert.equal(result.signals[0].value,'2000');
});

import {createAdminAuthority,verifyAdminAuthority,requiredAdminCapability} from '../dist/admin-authority.js';
import {redactTelemetryLogArguments} from '../dist/telemetry.js';
test('notification read state grants do not authorize notification creation or other writes',()=>{
 const ownerRequest={secret:request.secret,audience:'growth',actor:{id:'viewer',role:'viewer'},method:'POST',path:'/api/admin/notifications',body:'{"action":"mark_all_read"}'};
 assert.equal(verifyAdminAuthority(createAdminAuthority(ownerRequest),ownerRequest).id,'viewer');
 assert.equal(requiredAdminCapability('PATCH','/api/admin/notifications/id'),'admin:read');
 assert.equal(requiredAdminCapability('GET','/api/admin/operations/audit'),'admin:security');
 assert.throws(()=>createAdminAuthority({...ownerRequest,path:'/api/admin/notifications/publish'}));
 assert.throws(()=>createAdminAuthority({...ownerRequest,path:'/api/admin/customers/id/operations'}));
});
test('structured log redaction removes observer and human service authority',()=>{
 const [result]=redactTelemetryLogArguments([{headers:{'x-kasitek-operations-authority':'observer-token','x-kasitek-admin-authority':'admin-token'},status:'unavailable'}]);
 assert.equal(result.headers['x-kasitek-operations-authority'],'[REDACTED]');
 assert.equal(result.headers['x-kasitek-admin-authority'],'[REDACTED]');
 assert.equal(result.status,'unavailable');
});
