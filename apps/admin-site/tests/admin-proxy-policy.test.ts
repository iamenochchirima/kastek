import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import { proxy } from '../src/proxy';

test('admin HTTP proxy rejects cross-site and viewer mutations and preserves normal login/operator/owner paths',async()=>{
 const original=globalThis.fetch;
 const call=(path:string,method='GET',cookie?:string,origin?:string)=>proxy(new NextRequest(`http://localhost:3001${path}`,{method,headers:{...(cookie?{cookie}:{}),...(origin?{origin}:{})}}));
 try{
  assert.equal((await call('/api/agencies/test','PATCH')).status,403);
  assert.equal((await call('/api/agencies/test','PATCH',undefined,'http://localhost:3001')).status,401);
  globalThis.fetch=async()=>Response.json({id:'viewer',role:'viewer'});
  assert.equal((await call('/api/agencies/test','PATCH','kasitek_admin_session=synthetic','http://localhost:3001')).status,403);
  assert.equal((await call('/api/agencies/test/api-keys','POST','kasitek_admin_session=synthetic','http://localhost:3001')).status,403);
  assert.equal((await call('/api/agencies/test','GET','kasitek_admin_session=synthetic')).headers.get('x-middleware-next'),'1');
  for(const role of ['operator','owner']){
   globalThis.fetch=async()=>Response.json({id:role,role});
   assert.equal((await call('/api/agencies/test','PATCH','kasitek_admin_session=synthetic','http://localhost:3001')).headers.get('x-middleware-next'),'1');
  }
  assert.equal((await call('/api/core/admin/login','POST',undefined,'http://localhost:3001')).headers.get('x-middleware-next'),'1');
  assert.equal((await call('/api/core/admin/login','POST',undefined,'https://attacker.test')).status,403);
  assert.equal((await call('/api/auth/session')).headers.get('x-middleware-next'),'1');
 }finally{globalThis.fetch=original;}
});
