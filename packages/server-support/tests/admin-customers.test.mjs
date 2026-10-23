import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseCustomerOperation,parseCustomerPage,customerOperationDigest,customerActionEnabled,customerOperationsEnabled} from '../dist/admin-customers.js';
import {requiredAdminCapability,createAdminAuthority,verifyAdminAuthority} from '../dist/admin-authority.js';
const request={operationId:'operation-1234',action:'task.cancel',targetId:'task-1',expected:{state:'running',generation:2},reason:'Investigate stuck task'};
test('validates bounded requests and normalizes display text without trusting input',()=>{
 assert.equal(parseCustomerOperation({...request,label:'fake'}).label,'Request cancellation');
 for(const change of [{action:'task.retry'},{expected:{state:null}},{reason:'x'},{operationId:'../unsafe'},{selection:['a']},{arbitrary:'field'}])assert.throws(()=>parseCustomerOperation({...request,...change}));
 assert.throws(()=>parseCustomerOperation({...request,action:'ingress.retry'}));
 assert.throws(()=>parseCustomerOperation({...request,action:'ingress.retry',selection:['a','a']}));
 assert.deepEqual(parseCustomerPage({}),{limit:50,cursor:null});
 for(const q of [{limit:'101'},{limit:['2']},{limit:'1e2'},{cursor:['a']},{organizationId:'other'}])assert.throws(()=>parseCustomerPage(q));
});
test('idempotency binds actor product customer and complete request, independent of expected key ordering',()=>{
 const normalized=parseCustomerOperation(request);
 const d=customerOperationDigest('operator','agents','org',normalized);
 assert.equal(d,customerOperationDigest('operator','agents','org',{...normalized,expected:{generation:2,state:'running'}}));
 for(const [a,p,c,r] of [['other','agents','org',normalized],['operator','growth','org',normalized],['operator','agents','else',normalized],['operator','agents','org',{...normalized,reason:'Different reason'}],['operator','agents','org',{...normalized,targetId:'task-2'}]])assert.notEqual(d,customerOperationDigest(a,p,c,r));
});
test('metadata and actions have independent development gates',()=>{
 const env={NODE_ENV:'development',KASITEK_CUSTOMER_OPERATIONS:'1',KASITEK_CUSTOMER_ACTIONS:'task.cancel, client.resume'};
 assert.equal(customerOperationsEnabled(env),true);assert.equal(customerActionEnabled('task.cancel',env),true);assert.equal(customerActionEnabled('client.suspend',env),false);
 assert.equal(customerActionEnabled('task.cancel',{...env,NODE_ENV:'production'}),false);
 assert.equal(customerOperationsEnabled({}),false);
});
test('customer reads and commands require exact authority and correct capability',()=>{
 const path='/api/admin/customers/customer/operations';
 assert.equal(requiredAdminCapability('GET',path),'admin:read');assert.equal(requiredAdminCapability('POST',path+'/preview'),'admin:operate');
 const input={secret:'x'.repeat(40),audience:'agents',method:'POST',path,body:JSON.stringify(request)};
 assert.throws(()=>createAdminAuthority({...input,actor:{id:'viewer',role:'viewer'}}));
 const token=createAdminAuthority({...input,actor:{id:'operator',role:'operator'}});
 assert.equal(verifyAdminAuthority(token,input).capability,'admin:operate');
 assert.throws(()=>verifyAdminAuthority(token,{...input,path:path+'/other'}));
 assert.throws(()=>verifyAdminAuthority(token,{...input,body:'{}'}));
});
