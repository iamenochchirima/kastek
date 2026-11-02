export interface CollectorSpan {traceId:string;parentId:string;spanId:string;name:string;observationId:string;eventKey:string;taskId:string;rootTaskId:string}
/** Observe periodic exports after load measurement without inventing missing evidence. */
export async function observeCollectorEvidence<T extends {spans:unknown[];metricNames:string[]}>(read:()=>T,stopped:()=>boolean,maxWaitMs=20000){
 const started=Date.now();let captured=read();
 while(!stopped()&&(!captured.spans.length||!captured.metricNames.length)&&Date.now()-started<maxWaitMs){
  await new Promise(resolve=>setTimeout(resolve,Math.min(200,maxWaitMs-(Date.now()-started))));captured=read();
 }
 return{captured,evidenceWaitMs:Date.now()-started};
}
/** Retain only explicit metadata; raw Collector output and payloads never enter the artifact. */
export function collectorMetadata(secret:string,limit=20000){
 const spans=new Map<string,CollectorSpan>(),metrics=new Set<string>(),buffers={stdout:'',stderr:''},pending:{stdout?:CollectorSpan;stderr?:CollectorSpan}={};
 let privateContentLeaked=false,metadataTruncated=false;const privacyTails={stdout:'',stderr:''};
 function flush(stream:'stdout'|'stderr'){const span=pending[stream];if(!span?.observationId||!span.spanId||!span.taskId||!span.rootTaskId)return;const key=span.traceId+':'+span.spanId;if(spans.size>=limit&&!spans.has(key)){metadataTruncated=true;return;}spans.set(key,{...span});}
 function line(text:string,stream:'stdout'|'stderr'){
  const metric=text.match(/-> Name: (agents\.[a-zA-Z0-9_.]{1,100})/);if(metric)metrics.add(metric[1]!);
  if(/^Span #\d+\s*$/.test(text)){flush(stream);pending[stream]={traceId:'',parentId:'',spanId:'',name:'',observationId:'',eventKey:'',taskId:'',rootTaskId:''};return;}
  const span=pending[stream];if(!span)return;
  for(const[key,pattern]of Object.entries({traceId:/^\s*Trace ID\s*:\s*([a-f0-9]{32})/,parentId:/^\s*Parent ID\s*:\s*([a-f0-9]{16})/,spanId:/^\s*ID\s*:\s*([a-f0-9]{16})/,name:/^\s*Name\s*:\s*([a-zA-Z0-9_.:-]+)/,observationId:/agents.observation_id: Str\(([a-f0-9]{64})\)/,eventKey:/agents.event_key: Str\(([a-zA-Z0-9_.:-]{1,200})\)/,taskId:/agents.taskId: Str\(([a-f0-9-]{36})\)/,rootTaskId:/agents.rootTaskId: Str\(([a-f0-9-]{36})\)/})){const match=text.match(pattern);if(match)(span as unknown as Record<string,string>)[key]=match[1]!;}
 }
 return{ingest(chunk:string,stream:'stdout'|'stderr'='stdout'){
  const scan=privacyTails[stream]+chunk;if(scan.includes('CONTROLLED_PRIVATE_CANARY')||!!secret&&scan.includes(secret))privateContentLeaked=true;privacyTails[stream]=scan.slice(-Math.max(128,secret.length));
  const data=buffers[stream]+chunk,lines=data.split('\n');buffers[stream]=lines.pop()??'';if(buffers[stream].length>65536){buffers[stream]='';metadataTruncated=true;}for(const value of lines)line(value,stream);
 },snapshot(){flush('stdout');flush('stderr');return{spans:[...spans.values()],metricNames:[...metrics],privateContentLeaked,metadataTruncated};}};
}
