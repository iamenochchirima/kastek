import assert from 'node:assert/strict';
import test from 'node:test';
import type {Pool} from 'pg';
import {buildApp} from '../src/app.js';
import {readConfig} from '../src/config.js';
import type {CoreContext} from '../src/context.js';
import {acceptsUrlencodedForm} from '../src/error.js';
import {registerOrganizationRoutes} from '../src/routes/orgs.js';

test('organization JSON DTO rejects malformed bodies before session activity',async()=>{
 let sessionQueries=0;
 const pool={
  async connect(){return {
   async query(sql:string){
    if(sql.includes('SELECT "userId","refreshToken"'))sessionQueries++;
    return {rows:[]};
   },
   release(){},
  };},
 } as unknown as Pool;
 const context={
  config:readConfig({DATABASE_URL:'postgres://unused',FRONTEND_URL:'http://localhost:3000',LOG_LEVEL:'silent'}),
  pool,
 } as CoreContext;
 const app=await buildApp(context,[registerOrganizationRoutes]);
 try{
  for(const payload of ['{}','{"name":false}','{"name":"ok","slug":1}']){
   const response=await app.inject({method:'POST',url:'/api/orgs',headers:{cookie:'kasitek_session=fixture',origin:'http://localhost:3000','content-type':'application/json'},payload});
   assert.equal(response.statusCode,400,payload);
  }
  assert.equal(sessionQueries,0);
  const valid=await app.inject({method:'POST',url:'/api/orgs',headers:{cookie:'kasitek_session=fixture',origin:'http://localhost:3000','content-type':'application/json'},payload:'{"name":"ok","slug":null,"logo":null}'});
  assert.equal(valid.statusCode,401);
  assert.equal(sessionQueries,1);
 }finally{await app.close();}
});

test('Growth accepts JSON suffix media, rejects form data on a JSON route and keeps real form routes',async()=>{
 const context={
  config:readConfig({DATABASE_URL:'postgres://unused',FRONTEND_URL:'http://localhost:3000',LOG_LEVEL:'silent'}),
  pool:{} as Pool,
 } as CoreContext;
 const app=await buildApp(context,[registerOrganizationRoutes]);
 try{
  for(const contentType of ['application/json','application/problem+json','application/vnd.api+json']){
   const response=await app.inject({method:'POST',url:'/api/orgs',headers:{'content-type':contentType},payload:'{"name":"valid"}'});
   assert.equal(response.statusCode,401,contentType);
  }
  const duplicate=await app.inject({method:'POST',url:'/api/orgs',headers:{'content-type':'application/problem+json'},payload:'{"name":"first","name":"second"}'});
  assert.equal(duplicate.statusCode,400);
  assert.match(duplicate.body,/duplicate field `name`/);
  const formOnJson=await app.inject({method:'POST',url:'/api/orgs',headers:{'content-type':'application/x-www-form-urlencoded'},payload:'name=valid'});
  assert.equal(formOnJson.statusCode,400);
  assert.match(formOnJson.body,/Content type error/);
  assert.equal(acceptsUrlencodedForm('/api/auth/backchannel-logout'),true);
  assert.equal(acceptsUrlencodedForm('/api/orgs'),false);
 }finally{await app.close();}
});
