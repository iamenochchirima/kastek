/** Disposable compiled worker process for evaluator restart acceptance. */
import assert from "node:assert/strict";
import {randomBytes} from "node:crypto";
import {spawn,type ChildProcess} from "node:child_process";
import {once} from "node:events";
import {createServer} from "node:http";
import {writeFile} from "node:fs/promises";
import {join} from "node:path";

export async function prepareHarborWorker(input:{compiled:string;api:string;directory:string;databaseUrl:string;provider:typeof fetch;modelVaultKey:string}) {
  const credential=randomBytes(32).toString("base64url");
  const bridge=createServer(async(request,response)=>{
    if(request.method!=="POST"||request.url!=="/provider"||request.headers.authorization!==`Bearer ${credential}`){response.writeHead(403).end();return;}
    try{
      const chunks:Buffer[]=[];let bytes=0;
      for await(const part of request){const chunk=Buffer.from(part);bytes+=chunk.length;if(bytes>1048576)throw Error("FIXTURE_REQUEST_BOUND");chunks.push(chunk);}
      const result=await input.provider("https://openrouter.ai/api/v1/chat/completions",{method:"POST",body:Buffer.concat(chunks).toString("utf8")});
      response.writeHead(result.status,{"content-type":result.headers.get("content-type")??"application/octet-stream"});response.end(Buffer.from(await result.arrayBuffer()));
    }catch{response.writeHead(500).end();}
  });
  await new Promise<void>(resolve=>bridge.listen(0,"127.0.0.1",resolve));
  const providerUrl=`http://127.0.0.1:${(bridge.address() as {port:number}).port}/provider`;
  const script=join(input.directory,"compiled-worker.cjs");
  await writeFile(script,`
const {Pool}=require('pg');
const {createServer}=require('node:http2');
const {createEndpointHandler}=require('@restatedev/restate-sdk');
const load=name=>require(process.env.HARBOR_COMPILED+'/'+name);
const {privateStoreFromEnvironment}=load('infrastructure/object-store.js');
const {EvidenceStore}=load('execution/context/evidence.js');
const {KnowledgeRuntime}=load('platform/knowledge/knowledge-runtime.js');
const {createBusinessWorkflow}=load('execution/business/business.js');
const {ModelProviderStore}=load('product/model-providers/store.js');
const {ModelCredentialVault}=load('infrastructure/model-credential-vault.js');
const {ConnectionVault}=load('infrastructure/vault.js');
const {dispatchBoundModel}=load('execution/models/dispatch.js');
const pool=new Pool({connectionString:process.env.AGENTS_DATABASE_URL});
const evidence=new EvidenceStore(pool,privateStoreFromEnvironment());
const abort=new AbortController();
const fixtureFetch=(_url,request)=>fetch(process.env.HARBOR_PROVIDER_URL,{method:'POST',headers:{authorization:'Bearer '+process.env.HARBOR_PROVIDER_CREDENTIAL,'content-type':'application/json'},body:request.body});
const modelProvider=new ModelProviderStore(pool,new ModelCredentialVault(new ConnectionVault('harbor-model',{'harbor-model':process.env.HARBOR_MODEL_VAULT_KEY})));
const options={modelProvider,modelRuntime:{dispatch:input=>dispatchBoundModel(input,policy=>{
  const network=async(url,request)=>{if(!policy.authorizeUrl(new URL(String(url))))throw Error('Fixture destination denied');await policy.beforeDispatch?.();return fixtureFetch(url,request);};network.markProgress=()=>{};return network;
})},evidence,knowledgeRuntime:new KnowledgeRuntime(pool,evidence),signal:abort.signal};
const workflow=createBusinessWorkflow(pool,options);
const sharedWorkflow=createBusinessWorkflow(pool,options,{release:'product-capabilities-v15',workflow:'AgentsBusinessRunV25'});
const server=createServer(createEndpointHandler({services:[workflow,sharedWorkflow]}));
const sessions=new Set();server.on('session',session=>{sessions.add(session);session.once('close',()=>sessions.delete(session));});
server.listen(Number(process.env.HARBOR_WORKER_PORT||0),'0.0.0.0',()=>process.send({port:server.address().port,pid:process.pid}));
process.once('SIGTERM',()=>{abort.abort();for(const session of sessions)session.destroy();server.close(()=>pool.end().then(()=>process.exit(0)));});
`,{mode:0o600});
  let child:ChildProcess|undefined,port=0;const pids:number[]=[];
  const stop=async()=>{if(!child?.pid||child.exitCode!==null)return;const current=child;current.kill("SIGTERM");const timer=setTimeout(()=>current.kill("SIGKILL"),5000);try{await once(current,"exit");}finally{clearTimeout(timer);}};
  const start=async()=>{
    const environment:NodeJS.ProcessEnv={PATH:process.env.PATH,NODE_ENV:"test",NODE_PATH:join(input.api,"node_modules"),AGENTS_DATABASE_URL:input.databaseUrl,
      HARBOR_COMPILED:input.compiled,HARBOR_MODEL_VAULT_KEY:input.modelVaultKey,HARBOR_WORKER_PORT:String(port),HARBOR_PROVIDER_URL:providerUrl,HARBOR_PROVIDER_CREDENTIAL:credential};
    for(const [key,value]of Object.entries(process.env))if(key.startsWith("AGENTS_S3_"))environment[key]=value;
    child=spawn(process.execPath,[script],{env:environment,stdio:["ignore","ignore","ignore","ipc"]});
    const current=child;
    const ready=await new Promise<{port:number;pid:number}>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error("COMPILED_WORKER_START_TIMEOUT")),15000);current.once("message",message=>{clearTimeout(timer);resolve(message as {port:number;pid:number});});current.once("exit",()=>{clearTimeout(timer);reject(Error("COMPILED_WORKER_EXITED"));});});
    assert.ok(ready.port>0&&ready.pid===current.pid);if(port)assert.equal(ready.port,port);port=ready.port;pids.push(ready.pid);
  };
  try{await start();}catch(error){await stop();await new Promise<void>(resolve=>bridge.close(()=>resolve()));throw error;}
  return {get port(){return port;},pids,async restart(){await stop();await start();},async cleanup(){await stop();await new Promise<void>(resolve=>bridge.close(()=>resolve()));}};
}
