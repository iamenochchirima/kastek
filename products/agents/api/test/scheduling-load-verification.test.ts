import {describe,it,expect} from 'vitest';
import {verifyModelCalls,verifyEffects,classifyRootOutcomes,fatalLoadFindings,type EffectIdentity,type PhysicalModelCall,type NativeModelCall} from './scheduling-load-verification';
describe('controlled load verifier calibration',()=>{
 const native:NativeModelCall={operationId:'model:task:0',attemptId:'attempt',taskId:'task',rootTaskId:'root',state:'completed',errorCode:null,bodyDigest:'body',providerRequestId:'physical-1'};
 const physical:PhysicalModelCall={id:'physical-1',worker:'worker-0',bodyDigest:'body',startedAt:1,endedAt:2,status:200};
 it('requires one exact physical request per native operation, not equal aggregate totals',()=>{
  expect(verifyModelCalls([physical],[native]).errors).toEqual([]);
  expect(verifyModelCalls([{...physical,id:'unrelated'}],[native]).errors.length).toBeGreaterThan(0);
  expect(verifyModelCalls([physical,{...physical,id:'physical-2',operationId:native.operationId,attemptId:native.attemptId}],[native]).errors).toContain('Native operation model:task:0:attempt made 2 physical calls');
  expect(verifyModelCalls([{...physical,bodyDigest:'different'}],[native]).errors.length).toBeGreaterThan(0);
  for(const mutation of [{status:500},{status:0},{endedAt:undefined}])expect(verifyModelCalls([{...physical,...mutation}],[native]).errors.length).toBeGreaterThan(0);
  expect(verifyModelCalls([physical],[{...native,state:'failed',errorCode:'MODEL_RATE_LIMITED'}]).errors.length).toBeGreaterThan(0);
  expect(verifyModelCalls([{...physical,taskId:'other-task'}],[native]).errors.length).toBeGreaterThan(0);
  expect(verifyModelCalls([{...physical,operationId:native.operationId,attemptId:'stale'}],[native]).errors.length).toBeGreaterThan(0);
  expect(verifyModelCalls([{...physical,attributionCount:2}],[native]).errors.length).toBeGreaterThan(0);
  expect(verifyModelCalls([physical],[native,{...native,attemptId:'another-attempt'}]).errors.length).toBeGreaterThan(0);
 });
 it('attributes rejected and uncertain outcomes to their actual operation attempt',()=>{
  const linked={...physical,status:429,operationId:native.operationId,attemptId:native.attemptId,taskId:native.taskId,rootTaskId:native.rootTaskId};
  expect(verifyModelCalls([linked],[{...native,providerRequestId:undefined,state:'failed',errorCode:'MODEL_RATE_LIMITED'}]).errors).toEqual([]);
  expect(verifyModelCalls([linked],[{...native,providerRequestId:undefined,state:'uncertain',errorCode:'OPERATION_OUTCOME_UNCERTAIN'}]).errors.length).toBeGreaterThan(0);
  expect(verifyModelCalls([{...linked,status:200}],[{...native,providerRequestId:undefined,state:'uncertain',errorCode:'OPERATION_OUTCOME_UNCERTAIN'}]).errors).toEqual([]);
  expect(verifyModelCalls([{...linked,attemptId:'stale'}],[{...native,providerRequestId:undefined}]).errors.length).toBeGreaterThan(0);
 });
 const action:EffectIdentity={id:'action',taskId:'task',rootTaskId:'root',nativeRootTaskId:'root',artifactTaskId:'task',artifactRootTaskId:'root',payloadDigest:'payload',computedPayloadDigest:'payload',artifactDigest:'artifact',nativeArtifactDigest:'artifact',receiptId:'action',receiptDigest:'payload'};
 const received={id:'action',payloadDigest:'payload',computedPayloadDigest:'payload',artifactDigest:'artifact',bytesDigest:'artifact'},post={id:'action',payloadDigest:'payload',computedPayloadDigest:'payload',artifactDigest:'artifact',status:200};
 it('rejects substituted receiver identities, bytes, roots and repeated POSTs despite equal counts',()=>{
  expect(verifyEffects([action],[received],[post]).errors).toEqual([]);
  expect(verifyEffects([action],[{...received,id:'replacement'}],[post]).errors.length).toBeGreaterThan(0);
  expect(verifyEffects([action],[{...received,bytesDigest:'changed'}],[post]).errors.length).toBeGreaterThan(0);
  expect(verifyEffects([{...action,nativeRootTaskId:'other-root'}],[received],[post]).errors.length).toBeGreaterThan(0);
  expect(verifyEffects([{...action,nativeArtifactDigest:'other-artifact'}],[received],[post]).errors.length).toBeGreaterThan(0);
  expect(verifyEffects([action],[received],[post,post]).errors.length).toBeGreaterThan(0);
 });
 it('allows only causally affected native fault outcomes and requires unaffected roots to complete',()=>{
  const unknown={id:'affected',state:'uncertain',errorCode:'OPERATION_OUTCOME_UNCERTAIN'};
  expect(classifyRootOutcomes([unknown],'worker-loss',['affected']).errors).toEqual([]);
  expect(classifyRootOutcomes([unknown,{...unknown,id:'unaffected'}],'worker-loss',['affected']).errors).toHaveLength(1);
  expect(classifyRootOutcomes([unknown],'none',['affected']).errors).toHaveLength(1);
  expect(classifyRootOutcomes([{id:'affected',state:'failed',errorCode:'MODEL_RATE_LIMITED'}],'provider-throttle',['affected']).errors).toEqual([]);
  expect(classifyRootOutcomes([{id:'affected',state:'failed',errorCode:'UNRELATED_FAILURE'}],'provider-throttle',['affected']).errors).toHaveLength(1);
 });
 it('fails every concrete audit or missing-grounding finding rather than trusting an incomplete regex',()=>{
  expect(fatalLoadFindings(['Final stale-generation assistant delivery audit failed','Expected grounded configuration count missing'])).toHaveLength(2);
  expect(fatalLoadFindings(['active concurrency target requires measured peak, accepted backlog is insufficient'])).toEqual([]);
 });
});
