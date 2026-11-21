import {createHash,randomUUID} from "node:crypto";
import {mkdir,mkdtemp,rm,stat,symlink,unlink,utimes,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {describe,expect,it} from "vitest";
import {DocumentRuntime} from "../src/platform/knowledge/document-runtime";
import {canonicalJson} from "../src/contracts/contracts";
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
async function fixture(legacy=false){
 const cache=await mkdtemp(join(tmpdir(),"document-integrity-")),modelDirectory=join(cache,"model"),runsc=join(cache,"runsc/runsc");
 const files={"document-worker.mjs":"worker-a","document-host.py":"host---a","document-lifecycle.py":"life---a"};
 const identity={name:"document-processing-v1",sources:Object.fromEntries(Object.entries(files).map(([name,value])=>[name,sha(value)])),model:{files:{"tokenizer.json":{sha256:sha("tokens-a"),bytes:8},"onnx/model.onnx":{sha256:sha("model--a"),bytes:8}}},runscSHA256:sha("runsc--a"),runscBundle:{runsc:sha("runsc--a"),"gvisor-bin/gvisor_sentry":sha("sentry-a")},...(!legacy?{runtimeArtifacts:{dep:{directory:true},"dep/index.js":{sha256:sha("packagea"),bytes:8},alias:{symlink:"dep"}}}:{})};
 const release="document-processing-v1@"+sha(canonicalJson(identity)),directory=join(cache,"profiles",release.split("@")[1]!);
 const contents=new Map<string,string>();for(const[name,value]of Object.entries(files))contents.set(join(directory,name==="document-worker.mjs"?"runtime/"+name:name),value);
 contents.set(join(modelDirectory,"tokenizer.json"),"tokens-a");contents.set(join(modelDirectory,"onnx/model.onnx"),"model--a");contents.set(runsc,"runsc--a");contents.set(join(cache,"runsc/gvisor-bin/gvisor_sentry"),"sentry-a");contents.set(join(directory,"runtime/node_modules/dep/index.js"),"packagea");
 for(const[path,value]of contents){await mkdir(join(path,".."),{recursive:true});await writeFile(path,value);}await symlink("dep",join(directory,"runtime/node_modules/alias"));
 await writeFile(join(directory,"manifest.json"),JSON.stringify({profileRelease:release,identity,rootfs:join(cache,"rootfs"),modelDirectory,runsc}));await writeFile(join(cache,"current-profile.json"),JSON.stringify({profileRelease:release}));
 return{cache,runtime:new DocumentRuntime({cache}),release,directory,contents};
}
describe("accepted document artifact integrity",()=>{
 it("rejects changed helpers, worker, gVisor, model, tokenizer and installed package bytes after warming digest caches",async()=>{
  const f=await fixture();try{await f.runtime.profile();for(const[path,original]of f.contents){const before=await stat(path);await writeFile(path,"z".repeat(Buffer.byteLength(original)));await utimes(path,before.atime,before.mtime);await expect(f.runtime.profile(f.release)).rejects.toMatchObject({code:"DOCUMENT_RUNTIME_UNAVAILABLE"});await writeFile(path,original);expect((await f.runtime.profile(f.release)).profileRelease).toBe(f.release);}}finally{await rm(f.cache,{recursive:true,force:true});}
 });
 it("rejects changed dependency links or injected unpinned package files",async()=>{
  const f=await fixture();try{await f.runtime.profile();const alias=join(f.directory,"runtime/node_modules/alias");await unlink(alias);await symlink("elsewhere",alias);await expect(f.runtime.profile()).rejects.toMatchObject({code:"DOCUMENT_RUNTIME_UNAVAILABLE"});await unlink(alias);await symlink("dep",alias);await writeFile(join(f.directory,"runtime/node_modules/extra.js"),"unreviewed");await expect(f.runtime.profile()).rejects.toMatchObject({code:"DOCUMENT_RUNTIME_UNAVAILABLE"});}finally{await rm(f.cache,{recursive:true,force:true});}
 });
 it("permits inspection of older pinned profiles but refuses new launches without a package artifact manifest",async()=>{
  const f=await fixture(true);try{expect((await f.runtime.profile()).profileRelease).toBe(f.release);await expect(f.runtime.start({allocationId:randomUUID(),jobId:randomUUID(),profileRelease:f.release,input:{kind:"parse",format:"text",content:Buffer.from("Never launched")}})).rejects.toMatchObject({code:"DOCUMENT_PROFILE_INTEGRITY_UNAVAILABLE"});expect(await f.runtime.available()).toBe(false);}finally{await rm(f.cache,{recursive:true,force:true});}
 });
});
