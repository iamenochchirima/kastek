import {describe,it,expect,vi} from 'vitest';
import {fixtureProfiler,profilePath,profileTarget,profileWindow,diagnosticProfileMode,queryTimings,sqlFamily} from './scheduling-load-profile';
import {observeFixtureDatabaseErrors} from './scheduling-load-diagnostics';
import {EventEmitter} from 'node:events';
describe('bounded diagnostic-only fixture profiling',()=>{
 it('arms exactlyAPI0 andworker0 and confines output to a unique owned run',()=>{
  const id='6ec56411-5a34-4214-9340-c875b9b345d8';expect(profilePath('/repo',id,'api',0)).toBe(`/repo/.audit/agents-load-profile-${id}/api0.cpuprofile`);
  for(const role of ['api','worker'])for(const index of [0,1,2,3])expect(profileTarget(role,index)).toBe(index===0);
  expect(()=>profilePath('/repo','../outside','api',0)).toThrow();expect(()=>profilePath('/repo',id,'worker',1)).toThrow();expect(profileTarget('driver',0)).toBe(false);
 });
 it('rejects shortened diagnostic runs being configured as acceptance stages',()=>{
  const options={enabled:true,full:true,roots:10000,replicas:4,fault:'none',barrier:'none',single:false,noisy:false,baseline:false};
  expect(diagnosticProfileMode(options)).toEqual({diagnosticOnly:true,acceptanceEligible:false});
  for(const change of [{roots:1000},{replicas:8},{full:false},{fault:'worker-loss'},{barrier:'operations'},{single:true},{noisy:true},{baseline:true}])expect(()=>diagnosticProfileMode({...options,...change})).toThrow();
  expect(profileWindow).toEqual({startMs:20000,durationMs:30000,samplingIntervalUs:1000});
 });
 it('automatically stops and persists once, no inspector port or heap commands',async()=>{
  const commands:string[]=[],emit=vi.fn(),persist=vi.fn(async()=>{});let deadline:()=>void=()=>{};const unref=vi.fn();
  const session={connect:vi.fn(),disconnect:vi.fn(),post(method:string,_params:object,callback:Function){commands.push(method);callback(null,method==='Profiler.stop'?{profile:{nodes:[],samples:[1,2]}}:{});}};
  const timer=vi.fn((callback:()=>void,ms:number)=>{expect(ms).toBe(30000);deadline=callback;return{unref};});
  const profiler=fixtureProfiler({path:'/owned/api0.cpuprofile',emit,persist,session:session as any,timer:timer as any,cancelTimer:vi.fn() as any});
  profiler.start();profiler.start();await vi.waitFor(()=>expect(timer).toHaveBeenCalledOnce());deadline();await profiler.stop('shutdown');await profiler.stop('shutdown');
  expect(persist).toHaveBeenCalledOnce();expect(commands).toEqual(['Profiler.enable','Profiler.setSamplingInterval','Profiler.start','Profiler.stop']);expect(session.disconnect).toHaveBeenCalledOnce();expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({state:'completed',sampleCount:2,reason:'deadline'});
 });
 it('flushes an active capture on shutdown and never starts a merely armed role',async()=>{
  const session={connect:vi.fn(),disconnect:vi.fn(),post(method:string,_params:object,callback:Function){callback(null,method==='Profiler.stop'?{profile:{nodes:[],samples:[]}}:{});}},persist=vi.fn(async()=>{}),emit=vi.fn();
  const idle=fixtureProfiler({path:'/owned/idle',session:session as any,persist,emit});await idle.stop('shutdown');expect(session.connect).not.toHaveBeenCalled();
  const active=fixtureProfiler({path:'/owned/api0',session:session as any,persist,emit});active.start();await vi.waitFor(()=>expect(emit).toHaveBeenCalled());await active.stop('shutdown');expect(persist).toHaveBeenCalledOnce();expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({reason:'shutdown',state:'completed'});
 });
 it('measures actual leased-client queries exactly once and emits only bounded families',async()=>{
  const timings=queryTimings(),pool=Object.assign(new EventEmitter(),{query:vi.fn(async(_input?:unknown)=>[])}),client={query:vi.fn(async(_input?:unknown)=>[])};
  observeFixtureDatabaseErrors(pool as any,timings);pool.emit('connect',client);timings.start();await pool.query('SELECT secret FROM tasks');await client.query('SELECT private_prompt FROM agents_platform.tasks WHERE id=$1');timings.stop();await client.query('SELECT other FROM tasks');
  expect(timings.snapshot()).toEqual([expect.objectContaining({family:'tasks:select',count:1})]);expect(JSON.stringify(timings.snapshot())).not.toContain('private_prompt');
  expect(sqlFamily('WITH tenants AS MATERIALIZED (SELECT 1) SELECT * FROM agents_platform.task_outbox')).toBe('dispatch-fair-claim');expect(sqlFamily('WITH terminal AS (SELECT task_id FROM agents_platform.task_outbox) UPDATE agents_platform.task_outbox SET lease_owner=NULL')).toBe('dispatch-terminal-cleanup');expect(sqlFamily('WITH due AS (SELECT 1) UPDATE agents_platform.task_outbox SET lease_owner=NULL')).toBe('task_outbox:with');expect(sqlFamily({text:'BEGIN'})).toBe('transaction');
 });
 it('captures and stops a real in-process CPU session without opening a port',async()=>{
  const emit=vi.fn(),persist=vi.fn(async(_path:string,data:string)=>{const profile=JSON.parse(data);expect(profile.nodes.length).toBeGreaterThan(0);});
  const profiler=fixtureProfiler({path:'/owned/native.cpuprofile',emit,persist});profiler.start();await vi.waitFor(()=>expect(emit).toHaveBeenCalledWith(expect.objectContaining({state:'started'})));
  for(let n=0;n<100000;n++)Math.sqrt(n);await profiler.stop('calibration');expect(persist).toHaveBeenCalledOnce();expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({state:'completed',reason:'calibration'});
 });
 it('does not store SQL or parameters and counts each callback only once',()=>{
  const timings=queryTimings();timings.start();const end=timings.begin({text:'UPDATE operations SET secret=$1',values:['PRIVATE']});end();end();timings.stop();
  const rows=timings.snapshot();expect(rows[0]).toMatchObject({family:'operations:update',count:1});expect(JSON.stringify(rows)).not.toMatch(/PRIVATE|secret|UPDATE/);
 });
});
