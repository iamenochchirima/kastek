import test from 'node:test';
import assert from 'node:assert/strict';
import {adminSessionTransport,loadAdminActor} from '../src/lib/admin-session-transport.ts';
test('configured Labs identity never falls back to Growth during outage or invalid session',async()=>{
 const originalFetch=globalThis.fetch,original=process.env.OPS_BACKEND_URL;
 process.env.OPS_BACKEND_URL='http://127.0.0.1:4400';
 try{
  assert.equal(adminSessionTransport().cookie,'labs_admin_session');
  let calls=0;
  globalThis.fetch=async(url,options)=>{calls++;assert.equal(url,'http://127.0.0.1:4400/auth/session');assert.equal(options.headers.Cookie,'labs_admin_session=fixture');return Response.json({admin:{id:'admin',role:'viewer',name:'Admin',email:''}});};
  assert.equal((await loadAdminActor('fixture')).role,'viewer');
  globalThis.fetch=async()=>{calls++;return new Response(null,{status:503});};
  assert.equal(await loadAdminActor('fixture'),null);assert.equal(calls,2);
  globalThis.fetch=async()=>Response.json({admin:{id:'admin',role:'invented',name:'Admin',email:''}});
  assert.equal(await loadAdminActor('fixture'),null);
  assert.equal(await loadAdminActor(undefined),null);
 }finally{globalThis.fetch=originalFetch;if(original===undefined)delete process.env.OPS_BACKEND_URL;else process.env.OPS_BACKEND_URL=original;}
});
