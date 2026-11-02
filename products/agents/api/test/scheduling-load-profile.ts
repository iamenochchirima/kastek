/** Fixture-only profiling. No inspector port, heap capture, SQL text or parameters. */
import {Session} from 'node:inspector';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
export const profileWindow={startMs:20000,durationMs:30000,samplingIntervalUs:1000} as const;
export function diagnosticProfileMode(options:{enabled:boolean;full:boolean;roots:number;replicas:number;fault:string;barrier:string;single:boolean;noisy:boolean;baseline:boolean}){
 if(options.enabled&&(!options.full||options.roots!==10000||options.replicas!==4||options.fault!=='none'||options.barrier!=='none'||options.single||options.noisy||options.baseline))throw Error('Diagnostic profile requires the isolated10k/four-replica mixed profile');
 return{diagnosticOnly:options.enabled,acceptanceEligible:!options.enabled};
}
export function profileTarget(role:string,index:number){return(role==='api'||role==='worker')&&index===0;}
export function profilePath(repository:string,runId:string,role:string,index:number){
 if(!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId)||!profileTarget(role,index))throw Error('Invalid owned profile target');
 return join(resolve(repository),'.audit',`agents-load-profile-${runId}`,`${role}0.cpuprofile`);
}
const limits=[1,2,5,10,20,50,100,200,500,1000,2000,5000,10000,30000,60000,120000,Infinity];
export function sqlFamily(input:unknown){
 const raw=typeof input==='string'?input:typeof(input as any)?.text==='string'?(input as any).text:'';
 const text=raw.toLowerCase().replace(/\s+/g,' ').trim();
 if(text.startsWith('with tenants as materialized')&&text.includes('agents_platform.task_outbox'))return'dispatch-fair-claim';
 if(text.startsWith('with terminal as')&&text.includes('agents_platform.task_outbox'))return'dispatch-terminal-cleanup';
 if(/^(begin|commit|rollback|savepoint|release savepoint)/.test(text))return'transaction';
 const table=['capacity_slots','capacity_requests','capacity_buckets','execution_roots','task_outbox','operations','tasks','context_snapshots','observation_exports','task_events','evidence','actions','organizations','usage_'].find(part=>text.includes(part))??'other';
 const verb=/^(select|insert|update|delete|with)/.exec(text)?.[1]??'other';
 return`${table}:${verb}`;
}
export function queryTimings(){
 let active=false;const rows=new Map<string,{family:string;count:number;totalMs:number;maxMs:number;histogram:number[]}>();
 return{start(){active=true;},stop(){active=false;},begin(input:unknown){
  if(!active)return()=>{};const family=sqlFamily(input),started=performance.now();let completed=false;
  return()=>{if(completed)return;completed=true;if(!active)return;const ms=performance.now()-started,row=rows.get(family)??{family,count:0,totalMs:0,maxMs:0,histogram:limits.map(()=>0)};
   row.count++;row.totalMs+=ms;row.maxMs=Math.max(row.maxMs,ms);row.histogram[limits.findIndex(limit=>ms<=limit)]++;rows.set(family,row);};
 },snapshot(){return[...rows.values()].map(row=>{let n=0;const p95Index=row.histogram.findIndex(count=>(n+=count)>=Math.ceil(row.count*.95));return{family:row.family,count:row.count,totalMs:Math.round(row.totalMs),maxMs:Math.round(row.maxMs),p95UpperBoundMs:Number.isFinite(limits[p95Index])?limits[p95Index]:null};});}};
}
export type QueryTimings=ReturnType<typeof queryTimings>;
export function fixtureProfiler(options:{path:string;emit:(item:unknown)=>void;session?:Session;timer?:typeof setTimeout;cancelTimer?:typeof clearTimeout;persist?:(path:string,data:string)=>Promise<void>}){
 const session=options.session??new Session(),timings=queryTimings(),timer=options.timer??setTimeout,cancel=options.cancelTimer??clearTimeout;
 const post=(method:string,params:object={})=>new Promise<any>((resolve,reject)=>session.post(method as any,params,(error,result)=>error?reject(error):resolve(result)));
 let state:'armed'|'starting'|'running'|'stopping'|'stopped'='armed',startedAt=0,deadline:ReturnType<typeof setTimeout>|undefined,starting:Promise<void>|undefined,stopping:Promise<void>|undefined;
 const persist=options.persist??(async(path,data)=>{await mkdir(resolve(path,'..'),{recursive:true});await writeFile(path,data,{flag:'wx',mode:0o600});});
 async function stop(reason:string):Promise<void>{
  if(stopping)return stopping;if(state==='armed'||state==='stopped')return;
  stopping=(async()=>{await starting;if(state!=='running')return;state='stopping';timings.stop();if(deadline)cancel(deadline);
   try{const {profile}=await post('Profiler.stop'),data=JSON.stringify(profile);if(Buffer.byteLength(data)>32*1024**2)throw Error('Profile size limit');await persist(options.path,data);
    options.emit({fixtureProfile:true,state:'completed',path:options.path,startedAt,endedAt:Date.now(),reason,sampleCount:profile.samples?.length??0,sql:timings.snapshot()});
   }catch{options.emit({fixtureProfile:true,state:'failed',reason:'Profile capture failed'});}finally{state='stopped';session.disconnect();}
  })();return stopping;
 }
 function start(){
  if(state!=='armed')return;state='starting';starting=(async()=>{try{session.connect();await post('Profiler.enable');await post('Profiler.setSamplingInterval',{interval:profileWindow.samplingIntervalUs});await post('Profiler.start');state='running';startedAt=Date.now();timings.start();options.emit({fixtureProfile:true,state:'started',path:options.path,startedAt});deadline=timer(()=>{void stop('deadline');},profileWindow.durationMs);deadline.unref();}catch{state='stopped';session.disconnect();options.emit({fixtureProfile:true,state:'failed',reason:'Profile start failed'});}})();
 }
 return{start,stop,timings};
}
