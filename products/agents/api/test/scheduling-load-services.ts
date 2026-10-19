import {createHash,randomBytes} from 'node:crypto';
import {execFileSync,spawn,type ChildProcess} from 'node:child_process';
import {createServer} from 'node:http';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {requestDigest} from '../src/contracts/contracts';
import type {EffectPost} from './scheduling-load-verification';
import {collectorMetadata} from './scheduling-load-collector';
import type {Pool} from 'pg';
import {createReportReceiver,initializeReportReceiver} from '../src/acceptance/report-receiver';

export const collectorImage='otel/opentelemetry-collector-contrib:0.158.0@sha256:c5918f78992ee73b0d6f0e599423ac5ec52dd5d9726733114d6eca53d5a32ed5';
/** Explicit controlled S3/provider boundaries. Native clients and receipts remain in use. */
export async function controlledLoadServices(pool:Pool,repository:string,runId:string){
 const objects=new Map<string,Buffer>(),key=randomBytes(32).toString('base64url');let totalBytes=0,posts=0;const postAudit:EffectPost[]=[];
 const s3=createServer(async(request,response)=>{
  const path=request.url??'';
  if(!path.startsWith('/controlled-load/')||!String(request.headers.authorization??'').startsWith('AWS4-HMAC-SHA256 ')){response.writeHead(403).end();return;}
  if(request.method==='PUT'){
   const chunks:Buffer[]=[];let bytes=0;
   for await(const chunk of request){bytes+=chunk.length;if(bytes>10485760){response.writeHead(413).end();return;}chunks.push(Buffer.from(chunk));}
   const body=Buffer.concat(chunks);
   if(createHash('sha256').update(body).digest('hex')!==request.headers['x-amz-content-sha256']){response.writeHead(400).end();return;}
   const next=totalBytes-(objects.get(path)?.length??0)+body.length;if(next>67108864){response.writeHead(507).end();return;}
   objects.set(path,body);totalBytes=next;response.writeHead(200).end();
  }else if(request.method==='GET'){const value=objects.get(path);if(!value){response.writeHead(404).end();return;}response.writeHead(200,{'content-length':value.length}).end(value);}
  else if(request.method==='DELETE'){totalBytes-=objects.get(path)?.length??0;objects.delete(path);response.writeHead(204).end();}
  else response.writeHead(405).end();
 });
 await new Promise<void>(resolve=>s3.listen(0,'127.0.0.1',resolve));
 await initializeReportReceiver(pool);const receiver=createReportReceiver({pool,keys:[{apiKey:key,resource:'reports:controlled-load'}],afterAccept:async()=>{posts++;}});
 receiver.addHook('onResponse',async(request,reply)=>{if(request.method==='POST'){const body=request.body as any;postAudit.push({id:String(request.headers['idempotency-key']??''),payloadDigest:String(request.headers['x-payload-digest']??''),computedPayloadDigest:requestDigest(body),artifactDigest:String(body?.report?.digest??''),status:reply.statusCode});}});
 const receiverOrigin=await receiver.listen({host:'127.0.0.1',port:0});
 const container=`agents-load-otel-${runId}`,docker=(...args:string[])=>execFileSync('docker',args,{encoding:'utf8',timeout:60000}).trim();
 let collectorOwned=false,closing=false,collectorLog:ChildProcess|undefined;const metadata=collectorMetadata(key),captureErrors:string[]=[];
 const environment:NodeJS.ProcessEnv={AGENTS_S3_ENDPOINT:`http://127.0.0.1:${(s3.address() as {port:number}).port}`,AGENTS_S3_REGION:'local',AGENTS_S3_BUCKET:'controlled-load',AGENTS_S3_ACCESS_KEY_ID:'controlled-fixture',AGENTS_S3_SECRET_ACCESS_KEY:key,
  AGENTS_CONNECTION_ACTIVE_KEY:'fixture',AGENTS_CONNECTION_KEYS:JSON.stringify({fixture:randomBytes(32).toString('base64')}),
  AGENTS_REPORT_DELIVERY_TARGETS:JSON.stringify([{id:'controlled-reports',label:'Controlled reports',url:receiverOrigin+'/deliveries',resource:'reports:controlled-load'}])};
 return {environment,reportKey:key,postAudit,reportPosts:()=>posts,objectBytes:()=>totalBytes,
  async startCollector(){
   docker('run','-d','--name',container,'--memory','256m','--log-opt','max-size=10m','--log-opt','max-file=3','-e','PORT=13133','-v',`${join(repository,'infra/observability/otel-collector/config.local.yaml')}:/etc/otelcol-contrib/config.yaml:ro`,'-p','127.0.0.1::4318','-p','127.0.0.1::13133',collectorImage);collectorOwned=true;
   const endpoint=`http://${docker('port',container,'4318/tcp')}`,health=`http://${docker('port',container,'13133/tcp')}`;
   for(let attempt=0;attempt<100;attempt++){try{if((await fetch(health)).ok){environment.OTEL_EXPORTER_OTLP_ENDPOINT=endpoint;collectorLog=spawn('docker',['logs','--follow','--tail','1000',container],{stdio:['ignore','pipe','pipe']});collectorLog.stdout!.on('data',chunk=>metadata.ingest(String(chunk),'stdout'));collectorLog.stderr!.on('data',chunk=>metadata.ingest(String(chunk),'stderr'));collectorLog.on('error',()=>captureErrors.push('Owned Collector metadata stream failed'));collectorLog.on('exit',(code)=>{if(!closing)captureErrors.push(`Owned Collector metadata stream exited:${code}`);});return endpoint;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}throw Error('Owned Collector readiness timeout');
  },
  pauseCollector(){if(!collectorOwned)throw Error('Collector is not owned');docker('pause',container);},
  resumeCollector(){if(!collectorOwned)throw Error('Collector is not owned');docker('unpause',container);},
  async collectorEvidence(){
   await new Promise(resolve=>setTimeout(resolve,100));const captured=metadata.snapshot(),path=join(repository,'.audit',`agents-load-collector-${runId}.json`);
   await writeFile(path,JSON.stringify({...captured,captureErrors},null,2));
   return{image:collectorImage,traces:captured.spans.length>0,metrics:captured.metricNames.length>0,...captured,captureErrors,objectBytes:totalBytes,reportPosts:posts,metadataPath:path};
  },
  async close(){closing=true;collectorLog?.kill('SIGTERM');if(collectorOwned){docker('rm','-f',container);collectorOwned=false;}await receiver.close();await new Promise<void>(resolve=>s3.close(()=>resolve()));objects.clear();}
 };
}
