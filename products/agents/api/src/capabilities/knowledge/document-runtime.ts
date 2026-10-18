import { execFile,spawn } from "node:child_process";
import { createHash,randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat,readdir,readFile,readlink,realpath,stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname,isAbsolute,join,relative } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { canonicalJson,PlatformError } from "../../contracts/contracts";
const execute=promisify(execFile),digest=(value:string|Uint8Array)=>createHash("sha256").update(value).digest("hex");
export interface DocumentPage {page:number;start:number;end:number;text:string}
export interface DocumentChunk extends DocumentPage {tokenCount:number}
export type DocumentInput={kind:"parse";format:"pdf"|"html"|"text"|"markdown";content:Uint8Array}|{kind:"chunk";pages:DocumentPage[];maxTokens?:384;overlap?:48}|{kind:"embed";mode:"query"|"document";texts:string[]};
export type DocumentOutput={kind:"parse";text:string;textDigest:string;pages:DocumentPage[];offsetEncoding:"utf16"}|{kind:"chunk";chunks:DocumentChunk[];offsetEncoding:"utf16";maxTokens:384;overlap:48}|{kind:"embed";vectors:number[][];tokenCounts:number[];dimensions:384;pooling:"cls";normalization:"l2";mode:"query"|"document"};
export interface DocumentAllocation {allocationId:string;jobId:string;profileRelease:string;input:DocumentInput}
export interface DocumentResourceStatus {allocationId:string;jobId?:string;profileRelease?:string;inputDigest?:string;unitName?:string;state:"prepared"|"running"|"completed"|"failed"|"uncertain"|"destroying"|"destroyed";errorCode?:string;durationMs?:number;memoryPeakBytes?:number}
export interface DocumentReceipt {allocationId:string;jobId:string;profileRelease:string;inputDigest:string;outputDigest?:string;durationMs:number;memoryPeakBytes:number}
export type DocumentRuntimeResult=({ok:true;result:DocumentOutput}|{ok:false;errorCode:string})&{receipt:DocumentReceipt};
export interface DocumentRuntimeConfiguration {cache:string}
export interface DocumentProfile {profileRelease:string;identity:Record<string,unknown>;rootfs:string;runsc:string;modelDirectory:string}
const unavailable=()=>new PlatformError("DOCUMENT_RUNTIME_UNAVAILABLE",503,"Document processing is unavailable");
const pageSchema=z.strictObject({page:z.number().int().positive(),start:z.number().int().nonnegative(),end:z.number().int().nonnegative(),text:z.string().max(1048576)});
const outputSchema=z.discriminatedUnion("kind",[
 z.strictObject({kind:z.literal("parse"),text:z.string().min(1).max(1048576),textDigest:z.string().regex(/^[a-f0-9]{64}$/),pages:z.array(pageSchema).min(1).max(200),offsetEncoding:z.literal("utf16")}),
 z.strictObject({kind:z.literal("chunk"),chunks:z.array(pageSchema.extend({tokenCount:z.number().int().min(3).max(384)})).max(1000),offsetEncoding:z.literal("utf16"),maxTokens:z.literal(384),overlap:z.literal(48)}),
 z.strictObject({kind:z.literal("embed"),vectors:z.array(z.array(z.number().finite()).length(384)).min(1).max(16),tokenCounts:z.array(z.number().int().min(3).max(512)).min(1).max(16),dimensions:z.literal(384),pooling:z.literal("cls"),normalization:z.literal("l2"),mode:z.enum(["query","document"])})
]);
function validateOutput(value:unknown):DocumentOutput {
 const parsed=outputSchema.safeParse(value);if(!parsed.success)throw unavailable();const output=parsed.data;
 if(output.kind==="parse"){
  if(Buffer.byteLength(output.text)>1048576||digest(output.text)!==output.textDigest)throw unavailable();let end=-2;
  for(let index=0;index<output.pages.length;index++){const page=output.pages[index]!;if(page.page!==index+1||page.start!==end+2||page.end!==page.start+page.text.length||output.text.slice(page.start,page.end)!==page.text)throw unavailable();end=page.end;}
  if(end!==output.text.length||output.pages.map(page=>page.text).join("\n\n")!==output.text)throw unavailable();
 }else if(output.kind==="chunk"){
  if(output.chunks.some(chunk=>chunk.end!==chunk.start+chunk.text.length||!chunk.text.trim())||output.chunks.reduce((total,chunk)=>total+Buffer.byteLength(chunk.text),0)>7340032)throw unavailable();
 }else if(output.vectors.length!==output.tokenCounts.length||output.mode==="document"&&output.tokenCounts.some(count=>count>384)||output.vectors.some(vector=>Math.abs(Math.hypot(...vector)-1)>0.0001))throw unavailable();
 return output;
}
export class DocumentRuntime {
 private verifiedRoots=new Map<string,string>();
 private async verifyFile(path:string,expected:string,size?:number):Promise<void>{
  const before=await lstat(path);if(!before.isFile()||size!==undefined&&before.size!==size)throw unavailable();
  const fingerprint=`${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
  if(this.verifiedRoots.get(path)===expected+":"+fingerprint)return;
  const hash=createHash("sha256");for await(const bytes of createReadStream(path))hash.update(bytes);
  const after=await lstat(path);if(hash.digest("hex")!==expected||`${after.dev}:${after.ino}:${after.size}:${after.mtimeMs}:${after.ctimeMs}`!==fingerprint)throw unavailable();
  this.verifiedRoots.set(path,expected+":"+fingerprint);
 }
 private async verifyRuntimeTree(root:string,raw:unknown):Promise<void>{
  const entries=z.record(z.string().regex(/^(?!\.\.?(?:\/|$))(?!.*\/\.\.?(?:\/|$))[A-Za-z0-9_@.\/+~=-]+$/),z.union([z.strictObject({directory:z.literal(true)}),z.strictObject({symlink:z.string().max(2048)}),z.strictObject({sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().nonnegative()})])).parse(raw);
  const actual:string[]=[];
  const walk=async(path:string,prefix:string):Promise<void>=>{for(const item of await readdir(path,{withFileTypes:true})){const name=prefix+item.name;actual.push(name);if(item.isDirectory())await walk(join(path,item.name),name+"/");}};
  await walk(root,"");if(actual.length!==Object.keys(entries).length||actual.some(name=>!Object.hasOwn(entries,name)))throw unavailable();
  for(let offset=0;offset<actual.length;offset+=64)await Promise.all(actual.slice(offset,offset+64).map(async name=>{const value=entries[name]!,path=join(root,name),meta=await lstat(path);
   if("directory" in value){if(!meta.isDirectory()||meta.isSymbolicLink())throw unavailable();}
   else if("symlink" in value){if(!meta.isSymbolicLink()||await readlink(path)!==value.symlink)throw unavailable();const target=relative(root,await realpath(path));if(target.startsWith("..")||isAbsolute(target))throw unavailable();}
   else await this.verifyFile(path,value.sha256,value.bytes);
  }));
 }
 constructor(readonly config:DocumentRuntimeConfiguration){if(process.platform!=="linux"||process.arch!=="x64"||!isAbsolute(config.cache))throw unavailable();}
 async profile(release?:string):Promise<DocumentProfile>{
  if(release)return this.loadProfile(release);
  try{const current=JSON.parse(await readFile(join(this.config.cache,"current-profile.json"),"utf8"));return this.loadProfile(current.profileRelease);}catch{throw unavailable();}
 }
 private async loadProfile(release:string,verifyInference=true):Promise<DocumentProfile>{
  const match=/^document-processing-v1@([a-f0-9]{64})$/.exec(release);if(!match)throw unavailable();
  const profile=JSON.parse(await readFile(join(this.config.cache,"profiles",match[1]!,"manifest.json"),"utf8")) as DocumentProfile;
  if(profile.profileRelease!==release||digest(canonicalJson(profile.identity))!==match[1])throw unavailable();
  const artifact=profile.identity.rootfsArtifact;
  if(artifact&&verifyInference){
   const schema=z.strictObject({image:z.string(),manifestDigest:z.string().regex(/^sha256:[a-f0-9]{64}$/),imageID:z.string().regex(/^sha256:[a-f0-9]{64}$/),nodeSHA256:z.string().regex(/^[a-f0-9]{64}$/),archiveSHA256:z.string().regex(/^[a-f0-9]{64}$/),archiveFormat:z.literal("canonical-tar-v1").optional()}),pinned=schema.parse(artifact);
   const directory=join(this.config.cache,"rootfs",pinned.manifestDigest.slice(7),...(pinned.archiveFormat?[pinned.archiveFormat]:[]));if(profile.rootfs!==join(directory,"rootfs"))throw unavailable();
   const stamp=join(directory,"provenance.json");if((await stat(stamp)).size>4096||canonicalJson(schema.parse(JSON.parse(await readFile(stamp,"utf8"))))!==canonicalJson(pinned))throw unavailable();
   await this.verifyFile(join(profile.rootfs,"usr/local/bin/node"),pinned.nodeSHA256);
  }
  const directory=join(this.config.cache,"profiles",match[1]!);
  const sourceHashes=z.record(z.string(),z.string().regex(/^[a-f0-9]{64}$/)).parse(profile.identity.sources);
  for(const name of ["document-worker.mjs","document-host.py","document-lifecycle.py"]){const expected=sourceHashes[name];if(!expected)throw unavailable();await this.verifyFile(join(directory,...(name==="document-worker.mjs"?["runtime",name]:[name])),expected);}
  if(verifyInference){
  const model=z.object({files:z.record(z.string(),z.object({sha256:z.string().regex(/^[a-f0-9]{64}$/),bytes:z.number().int().nonnegative()}))}).parse(profile.identity.model);
  for(const[name,value]of Object.entries(model.files)){if(name.includes("..")||isAbsolute(name))throw unavailable();await this.verifyFile(join(profile.modelDirectory,name),value.sha256,value.bytes);}
  }
  const runsc=z.string().regex(/^[a-f0-9]{64}$/).parse(profile.identity.runscSHA256);await this.verifyFile(profile.runsc,runsc);
  if(profile.identity.runscBundle){for(const[name,value]of Object.entries(z.record(z.string(),z.string().regex(/^[a-f0-9]{64}$/)).parse(profile.identity.runscBundle))){if(name.includes("..")||isAbsolute(name))throw unavailable();await this.verifyFile(join(dirname(profile.runsc),name),value);}}
  if(verifyInference&&profile.identity.runtimeArtifacts)await this.verifyRuntimeTree(join(directory,"runtime/node_modules"),profile.identity.runtimeArtifacts);
  return profile;
 }
 async available(release?:string):Promise<boolean>{try{
  const profile=await this.profile(release);if(!profile.identity.runtimeArtifacts)return false;await stat(join(profile.rootfs,"usr/local/bin/node"));
  await stat(join(dirname(profile.runsc),"gvisor-bin/gvisor_sentry"));await stat(join(dirname(profile.runsc),"gvisor-bin/checkpointgofer"));
  if(!(await execute(profile.runsc,["--version"],{timeout:5000,maxBuffer:8192})).stdout.includes("release-20261012.0"))return false;
  const code="import pathlib; p=pathlib.Path('/sys/fs/cgroup'+next(x.strip().split('::',1)[1] for x in open('/proc/self/cgroup') if x.startswith('0::'))); assert (p/'memory.max').read_text().strip()=='536870912'; assert (p/'memory.swap.max').read_text().strip()=='0'; assert (p/'pids.max').read_text().strip()=='64'; q,t=(p/'cpu.max').read_text().split(); assert q!='max' and 0<int(q)<=int(t)";
  await execute("systemd-run",["--user","--quiet","--wait","--pipe","--collect","--unit=kasitek-document-probe-"+randomUUID(),"--property=MemoryMax=536870912","--property=MemorySwapMax=0","--property=CPUQuota=100%","--property=TasksMax=64","/usr/bin/python3","-c",code],{timeout:10000,maxBuffer:8192});return true;
 }catch{return false;}}
 private async command(action:"start"|"status"|"destroy",id:string,payload?:object,release?:string):Promise<DocumentResourceStatus>{
  z.uuid().parse(id);
  if(!release){try{const path=join(this.config.cache,"journals",id+".json");if((await stat(path)).size>16384)throw unavailable();release=JSON.parse(await readFile(path,"utf8")).profileRelease;}catch(error){if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;}}
  const profile=release?await this.loadProfile(release,action==="start"):await this.profile();
  if(action==="start"&&!profile.identity.runtimeArtifacts)throw new PlatformError("DOCUMENT_PROFILE_INTEGRITY_UNAVAILABLE",503,"Document processing profile must be prepared with verified package artifacts");
  const hash=profile.profileRelease.split("@")[1]!,helper=join(this.config.cache,"profiles",hash,"document-lifecycle.py");
  return new Promise((resolve,reject)=>{
   const env:NodeJS.ProcessEnv={PATH:"/usr/bin:/bin",XDG_RUNTIME_DIR:process.env.XDG_RUNTIME_DIR??`/run/user/${process.getuid!()}`};
   if(process.env.DBUS_SESSION_BUS_ADDRESS)env.DBUS_SESSION_BUS_ADDRESS=process.env.DBUS_SESSION_BUS_ADDRESS;
   const child=spawn("/usr/bin/python3",[helper,this.config.cache,action,id],{env,stdio:["pipe","pipe","pipe"]});let output="",bytes=0,settled=false;
   const timer=setTimeout(()=>{child.kill("SIGKILL");if(!settled){settled=true;reject(unavailable());}},25000);
   child.stdout.on("data",value=>{bytes+=value.length;if(bytes>16384){child.kill("SIGKILL");}else output+=value.toString();});
   child.stderr.resume();child.stdin.on("error",()=>{});child.on("error",()=>{clearTimeout(timer);if(!settled){settled=true;reject(unavailable());}});
   child.on("close",code=>{clearTimeout(timer);if(settled)return;settled=true;try{const value=JSON.parse(output);if(code!==0||value.errorCode&&!value.state)throw new PlatformError(value.errorCode??"DOCUMENT_RUNTIME_UNAVAILABLE",503,"Document processing is unavailable");resolve(value);}catch(error){reject(error instanceof PlatformError?error:unavailable());}});
   child.stdin.end(payload?JSON.stringify(payload):"");
  });
 }
 async start(request:DocumentAllocation,signal?:AbortSignal):Promise<DocumentResourceStatus>{
  z.uuid().parse(request.allocationId);z.uuid().parse(request.jobId);
  let input:Record<string,unknown>;
  if(request.input.kind==="parse"){
   if(!["pdf","html","text","markdown"].includes(request.input.format)||!request.input.content.byteLength||request.input.content.byteLength>10485760)throw new PlatformError("DOCUMENT_INPUT_LIMIT",400,"Document exceeds the processing profile");
   input={kind:"parse",format:request.input.format,contentBase64:Buffer.from(request.input.content).toString("base64")};
  }else if(request.input.kind==="chunk"){
   const pages=z.array(pageSchema).min(1).max(200).parse(request.input.pages);if(pages.reduce((sum,page)=>sum+Buffer.byteLength(page.text)+2,0)>1048578)throw new PlatformError("DOCUMENT_INPUT_LIMIT",400,"Document exceeds the processing profile");
   if(request.input.maxTokens!==undefined&&request.input.maxTokens!==384||request.input.overlap!==undefined&&request.input.overlap!==48)throw new PlatformError("DOCUMENT_PROFILE_UNAVAILABLE",400,"Document profile is unavailable");input={kind:"chunk",pages,maxTokens:384,overlap:48};
  }else if(request.input.kind==="embed"){
   const texts=z.array(z.string().min(1).max(131072)).min(1).max(16).parse(request.input.texts);if(!["query","document"].includes(request.input.mode)||texts.reduce((sum,text)=>sum+Buffer.byteLength(text),0)>131072)throw new PlatformError("EMBEDDING_INPUT_LIMIT",400,"Embedding batch exceeds its profile");input={kind:"embed",mode:request.input.mode,texts};
  }else throw new PlatformError("DOCUMENT_INPUT_INVALID",400,"Document input is invalid");
  const inputDigest=digest(canonicalJson({jobId:request.jobId,profileRelease:request.profileRelease,input}));
  if(signal?.aborted){await this.destroy(request.allocationId);throw new PlatformError("DOCUMENT_CANCELLED",409,"Document processing was cancelled");}
  let cleanup:Promise<unknown>|undefined;const abort=()=>{cleanup=this.destroy(request.allocationId).catch(()=>undefined);};signal?.addEventListener("abort",abort,{once:true});
  try{const value=await this.command("start",request.allocationId,{jobId:request.jobId,profileRelease:request.profileRelease,inputDigest,input},request.profileRelease);if(signal?.aborted){await cleanup;throw new PlatformError("DOCUMENT_CANCELLED",409,"Document processing was cancelled");}return value;}
  finally{signal?.removeEventListener("abort",abort);}
 }
 status(id:string){return this.command("status",id);}
 destroy(id:string){return this.command("destroy",id);}
 async result(id:string):Promise<DocumentRuntimeResult|undefined>{
  const state=await this.status(id);if(!["completed","failed"].includes(state.state))return;
  const root=join(this.config.cache,"resources",id),metadata=join(root,"result.json");if((await stat(metadata)).size>16384)throw unavailable();const meta=JSON.parse(await readFile(metadata,"utf8"));
  const receipt:DocumentReceipt={allocationId:id,jobId:state.jobId!,profileRelease:state.profileRelease!,inputDigest:state.inputDigest!,outputDigest:meta.outputDigest,durationMs:meta.durationMs,memoryPeakBytes:meta.memoryPeakBytes};
  if(!meta.outputDigest)return{ok:false,errorCode:meta.errorCode??"DOCUMENT_RUNTIME_FAILED",receipt};
  const outputPath=join(root,"output.json");if((await stat(outputPath)).size>8388608)throw unavailable();
  const bytes=await readFile(outputPath);if(bytes.length>8388608||digest(bytes)!==meta.outputDigest)throw unavailable();const output=JSON.parse(bytes.toString("utf8"));
  if(output.ok===false&&typeof output.errorCode==="string"&&/^[A-Z_]{1,80}$/.test(output.errorCode))return{ok:false,errorCode:output.errorCode,receipt};
  if(output.ok!==true)throw unavailable();return{ok:true,result:validateOutput(output.result),receipt};
 }
}
export function documentRuntimeFromEnvironment(env:NodeJS.ProcessEnv=process.env):DocumentRuntime|undefined{return env.AGENTS_DOCUMENT_RUNTIME_ENABLED==="1"?new DocumentRuntime({cache:env.AGENTS_DOCUMENT_RUNTIME_CACHE??join(homedir(),".cache/kasitek-documents")}):undefined;}
