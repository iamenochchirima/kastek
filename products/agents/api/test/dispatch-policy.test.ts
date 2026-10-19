import {describe,it,expect} from 'vitest';
import {dispatchPolicyFromEnvironment} from '../src/execution/scheduling/dispatch-claims';

describe('operator dispatch policy',()=>{
 it('retains finite defaults and accepts explicit partial policies',()=>{
  expect(dispatchPolicyFromEnvironment({})).toEqual({batchSize:32,parallelism:8,leaseMs:120000});
  expect(dispatchPolicyFromEnvironment({AGENTS_DISPATCH_POLICY_JSON:'{}'})).toEqual({batchSize:32,parallelism:8,leaseMs:120000});
  expect(dispatchPolicyFromEnvironment({AGENTS_DISPATCH_POLICY_JSON:'{"batchSize":128,"parallelism":32}'})).toEqual({batchSize:128,parallelism:32,leaseMs:120000});
  expect(dispatchPolicyFromEnvironment({AGENTS_DISPATCH_POLICY_JSON:'{"batchSize":1,"parallelism":1,"leaseMs":30000}'})).toEqual({batchSize:1,parallelism:1,leaseMs:30000});
  expect(dispatchPolicyFromEnvironment({AGENTS_DISPATCH_POLICY_JSON:'{"leaseMs":300000}'}).leaseMs).toBe(300000);
 });
 it.each([
  '', 'not json', 'null', '[]', 'true', '32', '"policy"',
  '{"batchSize":0}', '{"batchSize":129}', '{"batchSize":1.5}', '{"batchSize":"32"}',
  '{"parallelism":0}', '{"parallelism":33}', '{"parallelism":false}',
  '{"leaseMs":29999}', '{"leaseMs":300001}', '{"leaseMs":null}',
  '{"unknown":"secret-config-value"}', '{"__proto__":{"batchSize":128}}',
  '{"batchSize":"secret-config-value"}', '{"secret-config-value":',
 ])('rejects malformed, unknown or out-of-bound policy without echoing it (%#)',raw=>{
  let failure:unknown;
  try{dispatchPolicyFromEnvironment({AGENTS_DISPATCH_POLICY_JSON:raw});}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe('Invalid dispatch policy');
  expect(String(failure)).not.toContain('secret-config-value');
  expect((failure as Error).cause).toBeUndefined();
 });
 it('returns independent parsed policies rather than mutable shared defaults',()=>{
  const changed=dispatchPolicyFromEnvironment({});changed.batchSize=128;
  expect(dispatchPolicyFromEnvironment({}).batchSize).toBe(32);
 });
});
