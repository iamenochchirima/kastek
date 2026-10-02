import {recordQueueAge as sharedQueueAge,resultSpan as sharedResultSpan} from '@kasitek/server-support/telemetry';
import type {ProcessKind} from './contracts.js';
import {SERVICE_NAME} from './contracts.js';
import {redactTelemetryText} from '@kasitek/server-support/telemetry';

export type RolloutCacheOutcome='hit'|'miss'|'stale'|'unavailable'|'disabled';
export type LogLevel='debug'|'info'|'warn'|'error';
export interface ResultSpanMetrics {
 recordQueueAge(queue:string,ageMs:number):void;
 resultSpan<T>(component:'queue'|'worker',operation:string,callback:()=>Promise<T>):Promise<T>;
 log(level:LogLevel,event:string,fields?:Record<string,unknown>):void;
}

/** Process-only counters. Labels never contain tenant, producer, or resource identifiers. */
export class ProcessMetrics implements ResultSpanMetrics {
 private readonly counts=new Map<string,bigint>();
 private increment(name:string,count=1n){this.counts.set(name,(this.counts.get(name)??0n)+count);}
 recordLiveness(){this.increment('kasitek_analytics_liveness_checks_total');}
 recordReadiness(ready:boolean){this.increment('kasitek_analytics_readiness_checks_total');if(!ready)this.increment('kasitek_analytics_readiness_failures_total');}
 recordScrape(authorized:boolean){this.increment('kasitek_analytics_metrics_scrapes_total');if(!authorized)this.increment('kasitek_analytics_metrics_denied_total');}
 recordRolloutEvaluation(allowed:boolean,defaulted:boolean){this.increment('kasitek_analytics_rollout_evaluations_total');if(defaulted)this.increment('kasitek_analytics_rollout_evaluations_defaulted_total');if(!allowed)this.increment('kasitek_analytics_rollout_evaluations_denied_total');}
 recordRolloutCache(outcome:RolloutCacheOutcome){this.increment(`kasitek_analytics_rollout_cache_${outcome}_total`);}
 recordExpiredControlsClosed(count:bigint|number){this.increment('kasitek_analytics_rollout_expired_controls_closed_total',BigInt(count));}
 recordQueueAge(queue:string,ageMs:number){if(Number.isFinite(ageMs)&&ageMs>=0)sharedQueueAge(queue,ageMs/1000);}
 resultSpan<T>(component:'queue'|'worker',operation:string,callback:()=>Promise<T>){return sharedResultSpan(component,operation,callback);}
 log(level:LogLevel,event:string,fields:Record<string,unknown>={}){
  const record={event,service:SERVICE_NAME,...fields};
  const line=JSON.stringify(record,(_key,value)=>typeof value==='bigint'?value.toString():value);
  const safe=redactTelemetryText(line,8192);
  (level==='debug'?console.debug:level==='info'?console.info:level==='warn'?console.warn:console.error)(safe);
 }
 render(process:ProcessKind){
  const labels=`service="${SERVICE_NAME}",process="${process}"`;
  const definitions:[string,string][]=[
   ['kasitek_analytics_process_info','Analytics process information.'],
   ['kasitek_analytics_liveness_checks_total','Liveness probes received.'],
   ['kasitek_analytics_readiness_checks_total','Readiness probes received.'],
   ['kasitek_analytics_readiness_failures_total','Readiness probes that found a dependency unavailable.'],
   ['kasitek_analytics_metrics_scrapes_total','Metrics endpoint requests received.'],
   ['kasitek_analytics_metrics_denied_total','Metrics endpoint requests rejected by authentication.'],
   ['kasitek_analytics_rollout_evaluations_total','Rollout decisions evaluated by the server.'],
   ['kasitek_analytics_rollout_evaluations_defaulted_total','Rollout decisions using a default policy.'],
   ['kasitek_analytics_rollout_evaluations_denied_total','Rollout decisions that denied access or rollout.'],
   ['kasitek_analytics_rollout_cache_hits_total','Rollout decisions served from the cache.'],
   ['kasitek_analytics_rollout_cache_misses_total','Rollout decision cache misses.'],
   ['kasitek_analytics_rollout_cache_stale_total','Stale rollout decision cache entries rejected.'],
   ['kasitek_analytics_rollout_cache_unavailable_total','Rollout cache operations that failed and fell back.'],
   ['kasitek_analytics_rollout_cache_disabled_total','Rollout evaluations with cache disabled.'],
   ['kasitek_analytics_rollout_expired_controls_closed_total','Expired rollout controls closed by maintenance.'],
  ];
  return definitions.map(([name,help],index)=>`# HELP ${name} ${help}\n# TYPE ${name} ${index===0?'gauge':'counter'}\n${name}{${labels}} ${index===0?'1':this.counts.get(name)??0n}`).join('\n')+'\n';
 }
}

export class MetricsAccess {
 constructor(private readonly token:string|null){}
 authorized(header:string|string[]|undefined):boolean{return this.token!==null&&typeof header==='string'&&header===`Bearer ${this.token}`;}
}
