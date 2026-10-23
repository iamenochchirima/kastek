import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseGrowthAgentProvisionRequest, parseGrowthAgentProvisionResult} from '../dist/index.js';
const request={version:'1',requestId:'e6f3a22f-daf6-4349-a928-5147abc46d93',tenantId:'growth-business',defaultsRevision:'1',modelProfileId:'growth-default',modelProfileRevision:'1'};
test('provisioning accepts a service-only identity without a fabricated human',()=>{
  assert.deepEqual(parseGrowthAgentProvisionRequest(request),request);
  for(const extra of [{actor:{subject:'owner'}},{apiKey:'not-a-real-key'},{configuration:{tools:['arbitrary']}}])assert.throws(()=>parseGrowthAgentProvisionRequest({...request,...extra}));
});
test('provisioning rejects unknown versions and missing or malformed scope',()=>{
  for(const change of [{tenantId:''},{requestId:'not-an-id'},{defaultsRevision:'2'},{version:'2'},{modelProfileRevision:undefined},{tenantId:'foreign\nbusiness'}])assert.throws(()=>parseGrowthAgentProvisionRequest({...request,...change}));
});
test('readiness cannot claim success alongside a blocked reason',()=>{
  const {requestId,...scope}=request;
  assert.deepEqual(parseGrowthAgentProvisionResult({...scope,state:'ready'}),{...scope,state:'ready'});
  assert.equal(parseGrowthAgentProvisionResult({...scope,state:'blocked',code:'MODEL_UNAVAILABLE'}).code,'MODEL_UNAVAILABLE');
  for(const change of [{state:'ready',code:'MODEL_UNAVAILABLE'},{state:'blocked'},{state:'blocked',code:'provider secret or arbitrary text'}])assert.throws(()=>parseGrowthAgentProvisionResult({...scope,...change}));
});
