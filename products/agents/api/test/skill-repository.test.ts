import {createHash} from "node:crypto";
import {createServer} from "node:http";
import {describe,it,expect} from "vitest";
import {acquireSkillRepository} from "../src/capabilities/skills/repository";
import {parseSkillRequirements} from "../src/capabilities/skills/requirements";
import {assertSkillRequirements} from "../src/capabilities/skills/requirement-authority";
import {defaultBusinessConfiguration} from "../src/contracts/contracts";
import {skillFamilyId} from "../src/capabilities/skills/family";
const hash=(kind:string,bytes:Buffer)=>createHash("sha1").update(`${kind} ${bytes.length}\0`).update(bytes).digest("hex");
async function fixture(mode="100644",tamper=false,truncated=false){
 const content=Buffer.from("---\nname: repository-helper\ndescription: Use this procedure for repository evidence.\n---\nReview sources before answering."),blob=hash("blob",content);
 const tree=hash("tree",Buffer.concat([Buffer.from(`${mode} SKILL.md\0`),Buffer.from(blob,"hex")])),commit="a".repeat(40),requests:string[]=[];
 const server=createServer((req,res)=>{requests.push(req.url!);res.setHeader("content-type","application/json");
 if(req.url?.endsWith(`/commits/${commit}`))res.end(JSON.stringify({sha:commit,tree:{sha:tree}}));
 else if(req.url?.endsWith(`/trees/${tree}`))res.end(JSON.stringify({sha:tree,truncated,tree:[{path:"SKILL.md",mode,type:"blob",sha:blob,size:content.length}]}));
 else if(req.url?.endsWith(`/blobs/${blob}`))res.end(JSON.stringify({sha:blob,encoding:"base64",size:content.length,content:(tamper?Buffer.alloc(content.length):content).toString("base64")}));
 else {res.statusCode=404;res.end("{}");}});
 await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const address=server.address() as {port:number};
 return {input:{repository:"example/procedures",commit,path:""},options:{testLoopbackOrigin:`http://127.0.0.1:${address.port}`},requests,close:()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))};
}
describe("immutable public skill repository acquisition",()=>{
 it("verifies Git tree and blob hashes at the selected commit without running package code",async()=>{const f=await fixture();try{const result=await acquireSkillRepository(f.input,f.options);expect(result.package.name).toBe("repository-helper");expect(result.source).toMatchObject(f.input);expect(f.requests).toHaveLength(3);}finally{await f.close();}});
 it.each([["120000",false,false],["100644",true,false],["100644",false,true]])("rejects links, altered bytes and incomplete trees %s",async(mode,tamper,truncated)=>{const f=await fixture(mode,tamper,truncated);try{await expect(acquireSkillRepository(f.input,f.options)).rejects.toThrow();}finally{await f.close();}});
 it("rejects mutable refs, arbitrary hosts and traversal before provider reads",async()=>{for(const input of [{repository:"https://evil.test/repo",commit:"a".repeat(40)},{repository:"owner/repo",commit:"main"},{repository:"owner/repo",commit:"a".repeat(40),path:"../private"}])await expect(acquireSkillRepository(input)).rejects.toThrow();});
});
describe("skill requirements and source families",()=>{
 it("requires explicit bounded known-format requirements without granting authority",()=>{const req=parseSkillRequirements(JSON.stringify({connectionProfiles:["custom-api-v1"],permissions:["connected.read"],runtimes:["python-analysis-v1"]}));expect(()=>assertSkillRequirements(req,defaultBusinessConfiguration(),[],[])).toThrow();expect(parseSkillRequirements(undefined).permissions).toEqual([]);for(const value of ['{"permissions":["connected.read","connected.read"]}','{"permissions":["*"]}','{"unknown":true}','null'])expect(()=>parseSkillRequirements(value)).toThrow();});
 it("keeps revisions in one family and isolates publishers and repository paths",()=>{const base={organizationId:"org",name:"helper"};const privateId=skillFamilyId(base);expect(skillFamilyId({...base})).toBe(privateId);expect(skillFamilyId({...base,sourceKind:"curated",sourceSlug:"helper"})).not.toBe(privateId);const repo={...base,repository:"Owner/Repo",packagePath:"skills/one"};expect(skillFamilyId(repo)).toBe(skillFamilyId({...repo,repository:"owner/repo"}));expect(skillFamilyId(repo)).not.toBe(skillFamilyId({...repo,packagePath:"skills/two"}));});
});
