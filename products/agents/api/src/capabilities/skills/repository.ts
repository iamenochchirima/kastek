import { createHash } from "node:crypto";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import { createBoundedFetch,ConnectedNetworkError } from "../../infrastructure/connected-network";
import { parseSkillPackage,SKILL_PACKAGE_LIMITS,validateSkillPath,type SkillPackage } from "./package";

const sha=z.string().regex(/^[a-f0-9]{40}$/);
export const skillRepositoryInput=z.strictObject({repository:z.string().max(201).regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/),
  commit:sha,path:z.string().max(256).default("")});
export interface SkillRepositorySource {repository:string;commit:string;path:string;tree:string}
export interface SkillRepositoryOptions {testLoopbackOrigin?:string;signal?:AbortSignal}
const entrySchema=z.object({path:z.string().min(1).max(1024),mode:z.enum(["040000","100644","100755","120000","160000"]),type:z.enum(["tree","blob","commit"]),sha,size:z.number().int().nonnegative().optional()});
type Entry=z.infer<typeof entrySchema>;
const failure=(message:string)=>new PlatformError("SKILL_REPOSITORY_INVALID",400,message);
function treeDigest(entries:Entry[]) {
  const content=entries.map(entry=>({entry,key:Buffer.from(entry.path+(entry.type==="tree"?"/":""))})).sort((a,b)=>Buffer.compare(a.key,b.key))
    .flatMap(({entry})=>[Buffer.from(`${entry.mode==="040000"?"40000":entry.mode} ${entry.path}\0`),Buffer.from(entry.sha,"hex")]);
  const bytes=Buffer.concat(content);return createHash("sha1").update(`tree ${bytes.length}\0`).update(bytes).digest("hex");
}
/** Only public GitHub commit objects are accepted; provider-supplied URLs are never followed. */
export async function acquireSkillRepository(raw:unknown,options:SkillRepositoryOptions={}):Promise<{package:SkillPackage;source:SkillRepositorySource}> {
  const input=skillRepositoryInput.parse(raw);if(input.path)validateSkillPath(input.path);
  let origin="https://api.github.com";
  if(options.testLoopbackOrigin){const fixture=new URL(options.testLoopbackOrigin);if(fixture.protocol!=="http:"||!["127.0.0.1","localhost","[::1]"].includes(fixture.hostname)||fixture.pathname!=="/"||fixture.username||fixture.password||fixture.search||fixture.hash)throw failure("Invalid repository fixture origin");origin=fixture.origin;}
  const [owner,repository]=input.repository.split("/"),base=`/repos/${owner}/${repository}/git/`;
  const urls=new Set<string>(),fetch=createBoundedFetch({authorizeUrl:url=>url.origin===origin&&urls.has(url.href),
    headers:{accept:"application/vnd.github+json","x-github-api-version":"2022-11-28","user-agent":"Kasitek-Agents"},
    maxRequestBytes:0,maxResponseBytes:2097152,deadlineAt:Date.now()+30000,maxRequests:32,maxAttempts:1,testLoopback:!!options.testLoopbackOrigin,signal:options.signal});
  async function json(path:string):Promise<unknown>{
    const url=origin+base+path;urls.add(url);
    try{const response=await fetch(url);if(response.status!==200)throw failure("The public repository commit or package path is unavailable");return await response.json();}
    catch(error){if(error instanceof PlatformError)throw error;if(error instanceof ConnectedNetworkError)throw new PlatformError(error.code==="REQUEST_LIMIT"?"SKILL_REPOSITORY_LIMIT":"SKILL_REPOSITORY_UNAVAILABLE",400,"Repository import exceeded its bounded public read allowance; use a ZIP package if necessary");throw failure("Invalid repository provider response");}
  }
  const commit=z.object({sha,tree:z.object({sha})}).safeParse(await json(`commits/${input.commit}`));
  if(!commit.success||commit.data.sha!==input.commit)throw failure("Repository did not return the selected immutable commit");
  const trees=new Map<string,Entry[]>();
  async function tree(id:string):Promise<Entry[]>{
    const cached=trees.get(id);if(cached)return cached;
    const result=z.object({sha,truncated:z.literal(false),tree:z.array(entrySchema).max(2000)}).safeParse(await json(`trees/${id}`));
    if(!result.success||result.data.sha!==id)throw failure("Repository tree is incomplete or exceeds import limits");
    const names=new Set<string>();
    for(const entry of result.data.tree){
      if(/[\/\0]/.test(entry.path)||names.has(entry.path)||(entry.type==="tree")!==(entry.mode==="040000")||(entry.type==="commit")!==(entry.mode==="160000"))throw failure("Repository tree contains invalid or ambiguous entries");names.add(entry.path);
    }
    if(treeDigest(result.data.tree)!==id)throw failure("Repository tree digest does not match the selected commit");
    trees.set(id,result.data.tree);return result.data.tree;
  }
  let packageTree=commit.data.tree.sha;
  for(const part of input.path?input.path.split("/"):[]){const entry=(await tree(packageTree)).find(entry=>entry.path===part);if(!entry||entry.type!=="tree"||entry.mode!=="040000")throw failure("Package path must identify a directory without links");packageTree=entry.sha;}
  const pending=[{sha:packageTree,prefix:""}],files:{path:string;sha:string;size:number}[]=[];
  let totalBytes=0,entries=0;
  while(pending.length){
    const current=pending.shift()!;
    for(const entry of await tree(current.sha)){
      if(++entries>SKILL_PACKAGE_LIMITS.archiveEntries)throw failure("Repository package has too many entries");
      const path=validateSkillPath(current.prefix+entry.path);
      if(entry.type==="tree"){pending.push({sha:entry.sha,prefix:path+"/"});continue;}
      if(entry.type!=="blob"||!["100644","100755"].includes(entry.mode)||entry.size===undefined)throw failure("Repository package cannot contain links or submodules");
      totalBytes+=entry.size;
      if(files.length>=SKILL_PACKAGE_LIMITS.files||entry.size>SKILL_PACKAGE_LIMITS.fileBytes||totalBytes>SKILL_PACKAGE_LIMITS.totalBytes)throw failure("Repository package exceeds file or total byte limits");
      files.push({path,sha:entry.sha,size:entry.size});
    }
  }
  const blobs=new Map<string,Buffer>(),manifest=[];
  for(const file of files){
    let bytes=blobs.get(file.sha);
    if(!bytes){
      const blob=z.object({sha,encoding:z.literal("base64"),size:z.number().int().nonnegative().max(SKILL_PACKAGE_LIMITS.fileBytes),content:z.string().max(800000)}).safeParse(await json(`blobs/${file.sha}`));
      if(!blob.success||blob.data.sha!==file.sha||blob.data.size!==file.size)throw failure("Repository blob does not match its immutable tree entry");
      const encoded=blob.data.content.replace(/[\r\n]/g,"");
      if(!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded))throw failure("Repository returned invalid blob encoding");
      bytes=Buffer.from(encoded,"base64");
      if(bytes.length!==file.size||createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex")!==file.sha)throw failure("Repository blob digest does not match the selected commit");
      blobs.set(file.sha,bytes);
    }
    if(bytes.length!==file.size)throw failure("Repository blob size disagrees with its tree entry");
    manifest.push({path:file.path,content:bytes.toString("base64"),encoding:"base64"});
  }
  const pkg=parseSkillPackage({files:manifest});
  return {package:pkg,source:{repository:input.repository,commit:input.commit,path:input.path,tree:packageTree}};
}
