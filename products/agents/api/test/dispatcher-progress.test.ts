import {describe,it,expect,vi,afterEach} from 'vitest';
const mocks=vi.hoisted(()=>({advance:vi.fn(async()=>0),reconcile:vi.fn(async()=>{})}));
vi.mock('../src/execution/scheduling/capacity',()=>({advanceCapacity:mocks.advance}));
vi.mock('../src/execution/lifecycle/execution',()=>({HARNESS_RELEASE:'fixture',WORKFLOW_NAME:'AgentsBusinessRunV12',reconcilePendingRoots:mocks.reconcile,settleTask:vi.fn()}));
import {startDispatcher} from '../src/execution/lifecycle/dispatcher';
function emptyPool(){const query=vi.fn(async()=>({rows:[],rowCount:0})),client={query,release:vi.fn()};return{query,connect:vi.fn(async()=>client)};}
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();mocks.advance.mockReset().mockResolvedValue(0);});
describe('publisher progress cadence',()=>{
 it('keeps empty phases on the one-second idle backoff',async()=>{
  vi.useFakeTimers();const phases:string[]=[],pool=emptyPool(),dispatcher=startDispatcher(pool as any,{ingressUrl:'http://fixture.test',adminUrl:'http://fixture.test',onPhase:phase=>phases.push(phase)});
  try{await vi.advanceTimersByTimeAsync(0);expect(phases).toHaveLength(5);await vi.advanceTimersByTimeAsync(999);expect(phases).toHaveLength(5);await vi.advanceTimersByTimeAsync(1);expect(phases).toHaveLength(10);}finally{await dispatcher.stop();}
 });
 it('backs off errors instead of spinning productive retries',async()=>{
  vi.useFakeTimers();mocks.advance.mockRejectedValue(Error('Fixture failure'));const phases:{phase:string;success:boolean}[]=[],dispatcher=startDispatcher(emptyPool() as any,{ingressUrl:'http://fixture.test',adminUrl:'http://fixture.test',onPhase:(phase,_ms,success)=>phases.push({phase,success})});
  try{await vi.advanceTimersByTimeAsync(0);expect(phases.filter(x=>x.phase==='capacity')).toEqual([{phase:'capacity',success:false}]);await vi.advanceTimersByTimeAsync(999);expect(mocks.advance).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(1);expect(mocks.advance).toHaveBeenCalledTimes(2);}finally{await dispatcher.stop();}
 });
 it('yields between productive passes and checks stop before the next pass',async()=>{
  mocks.advance.mockResolvedValue(1);let dispatcher:ReturnType<typeof startDispatcher>,stop:Promise<void>|undefined,seen=0;
  dispatcher=startDispatcher(emptyPool() as any,{ingressUrl:'http://fixture.test',adminUrl:'http://fixture.test',onPhase:phase=>{if(phase==='capacity'){seen++;setImmediate(()=>{stop=dispatcher.stop();});}}});
  try{await vi.waitFor(()=>expect(stop).toBeDefined());await stop;expect(seen).toBe(1);expect(mocks.advance).toHaveBeenCalledTimes(1);}finally{await dispatcher.stop();}
 });
});
