import {createServer,type Server} from "node:http";
import {randomUUID} from "node:crypto";
import {afterEach,describe,it,expect} from "vitest";
import {importOpenApiDocument} from "../src/adapters/providers/openapi";
import {executeNativeApiOperation,type NativeApiOperationRuntime} from "../src/adapters/providers/native-api";
import {parseNativeResponsePolicy} from "../src/adapters/providers/native-response-policy";
import {requestDigest} from "../src/contracts/contracts";

const servers:Server[]=[];
const pagination={itemsPointer:"/data",nextCursorPointer:"/next",cursorParameter:"cursor",maxPages:3};
async function fixture(policy:unknown,replies:{status?:number;body?:unknown;retryAfter?:string;raw?:string;contentType?:string}[],effect:"owner_reviewed_read"|"exact_review"="owner_reviewed_read"){
 const requests:{url:string;authorization?:string}[]=[];
 const server=createServer((request,response)=>{const index=requests.length;requests.push({url:request.url!,authorization:request.headers.authorization});const reply=replies[Math.min(index,replies.length-1)]!;response.writeHead(reply.status??200,{"content-type":reply.contentType??"application/json",...(reply.retryAfter?{"retry-after":reply.retryAfter}:{})});response.end(reply.raw??JSON.stringify(reply.body??{data:[],next:null}));});
 servers.push(server);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));const origin=`http://127.0.0.1:${(server.address()as{port:number}).port}`,serverUrl=origin+"/api";
 const imported=importOpenApiDocument({openapi:"3.1.0",info:{title:"Paged records",version:"1"},servers:[{url:serverUrl}],components:{securitySchemes:{key:{type:"http",scheme:"bearer"}}},security:[{key:[]}],paths:{"/records":{get:{operationId:"records",parameters:[{name:"cursor",in:"query",schema:{type:"string",maxLength:2048}}],"x-kasitek-response":policy,responses:{"200":{description:"Page"}}}}}},{serverUrl,testLoopback:true});
 expect(imported.operations[0]!.diagnostics).toEqual([]);
 const operation:NativeApiOperationRuntime={operationId:randomUUID(),template:imported.operations[0]!.template!,serverOrigin:origin,importDigest:requestDigest(imported),policyRevision:1,credentialReferences:{key:"vault:fixture"},credentials:{"vault:fixture":{type:"bearer",token:"private-pagination-token"}},effectPolicy:effect};
 return{operation,requests,options:{deadlineAt:Date.now()+5000,testLoopback:true}};
}
afterEach(async()=>{for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});
describe("authorized API pagination, projection and bounded read retries",()=>{
 it("pages the declared cursor, narrows model output and retains complete private provider bytes",async()=>{
  const f=await fixture({pagination,projection:{fields:{id:"/id",title:"/title"}}},[{body:{data:[{id:1,title:"First",internal:"private-field"}],next:"second"}},{body:{data:[{id:2,title:"Second",internal:"other-private-field"}],next:null}}]);
  const receipts:number[]=[],admitted:number[]=[];const result=await executeNativeApiOperation(f.operation,{}, {...f.options,beforeAttempt:async a=>{admitted.push(a.attempt);},onAttempt:async a=>{receipts.push(a.attempt);}});
  expect(result.structuredContent).toEqual({items:[{id:1,title:"First"},{id:2,title:"Second"}],pageCount:2,complete:true});expect(result.text).not.toContain("private-field");expect(JSON.stringify(result.rawResult)).toContain("private-field");
  expect(f.requests.map(r=>r.url)).toEqual(["/api/records","/api/records?cursor=second"]);expect(f.requests.every(r=>r.authorization==="Bearer private-pagination-token")).toBe(true);expect(JSON.stringify(result)).not.toContain("private-pagination-token");expect(admitted).toEqual([1,2]);expect(receipts).toEqual([1,2]);
 });
 it("requires explicit read authorization before automatic requests",async()=>{
  const f=await fixture({pagination},[],"exact_review");await expect(executeNativeApiOperation(f.operation,{},f.options)).rejects.toMatchObject({code:"API_READ_AUTHORIZATION_REQUIRED"});expect(f.requests).toEqual([]);
 });
 it("returns a bounded continuation at the page limit",async()=>{
  const f=await fixture({pagination:{...pagination,maxPages:2}},[{body:{data:[1],next:"two"}},{body:{data:[2],next:"three"}},{body:{data:[3],next:null}}]);const result=await executeNativeApiOperation(f.operation,{},f.options);expect(result.structuredContent).toEqual({items:[1,2],pageCount:2,complete:false,nextCursor:"three"});expect(f.requests).toHaveLength(2);
 });
 it("treats a provider URL as a cursor value rather than a fetch destination",async()=>{
  const next="https://untrusted.example/private";const f=await fixture({pagination},[{body:{data:[1],next}},{body:{data:[2],next:null}}]);await executeNativeApiOperation(f.operation,{},f.options);expect(f.requests[1]!.url).toBe("/api/records?cursor="+encodeURIComponent(next));
 });
 it("refuses repeated cursors without an unbounded loop",async()=>{
  const f=await fixture({pagination},[{body:{data:[1],next:"same"}}]);await expect(executeNativeApiOperation(f.operation,{},f.options)).rejects.toMatchObject({code:"API_PAGINATION_INVALID"});expect(f.requests).toHaveLength(2);
 });
 it("retries explicit GET reads on transient status under a single physical request budget",async()=>{
  const f=await fixture({retry:{maxAttempts:3,maxDelayMs:20},projection:{fields:{result:"/result"}}},[{status:429,retryAfter:"0",body:{error:"rate-limited"}},{status:503,retryAfter:"0",body:{error:"retry"}},{body:{result:"done",omitted:"not for model"}}]);const result=await executeNativeApiOperation(f.operation,{},f.options);expect(result.structuredContent).toEqual({result:"done"});expect(result.attempts.map(a=>a.attempt)).toEqual([1,2,3]);expect(JSON.stringify(result.rawResult)).toContain("rate-limited");expect(f.requests).toHaveLength(3);
 });
 it.each([
  {policy:{retry:{maxAttempts:2,maxDelayMs:0}},status:200,raw:"Plain response",contentType:"text/plain"},
  {policy:{retry:{maxAttempts:2,maxDelayMs:0}},status:204,raw:"",contentType:"application/json"},
  {policy:{},status:200,raw:"Plain response",contentType:"text/plain"},
 ])("preserves successful text and empty results when JSON projection is not requested %j",async({policy,status,raw,contentType})=>{
   const f=await fixture(policy,[{status,raw,contentType}]);const result=await executeNativeApiOperation(f.operation,{},f.options);
   expect(result.status).toBe(status);expect(result.text).toBe(raw);expect(result.isError).toBe(false);expect(f.requests).toHaveLength(1);
 });
 it("does not shorten provider backoff beyond the configured retry bound",async()=>{
  const f=await fixture({retry:{maxAttempts:3,maxDelayMs:20}},[{status:429,retryAfter:"60",body:{error:"wait"}}]);const result=await executeNativeApiOperation(f.operation,{},f.options);expect(result.isError).toBe(true);expect(result.structuredContent).toMatchObject({error:{status:429},complete:false});expect(f.requests).toHaveLength(1);
 });
 it("rechecks authority before each subsequent page",async()=>{
  const f=await fixture({pagination},[{body:{data:[1],next:"two"}}]);let calls=0;await expect(executeNativeApiOperation(f.operation,{}, {...f.options,beforeAttempt:async()=>{if(++calls===2)throw Object.assign(new Error("Revoked"),{code:"REVOKED"});}})).rejects.toMatchObject({code:"REVOKED"});expect(f.requests).toHaveLength(1);
 });
 it("preserves the original deadline across pages",async()=>{
  const f=await fixture({pagination},[{body:{data:[1],next:"two"}}]);const options={...f.options,deadlineAt:Date.now()+100,beforeAttempt:async()=>{await new Promise(resolve=>setTimeout(resolve,125));}};await expect(executeNativeApiOperation(f.operation,{},options)).rejects.toThrow();expect(f.requests.length).toBeLessThanOrEqual(1);
 });
 it.each([
  {projection:{fields:{value:"/__proto__/key"}}},
  {projection:{fields:{value:"/bad~2escape"}}},
  {pagination:{...pagination,maxPages:5},retry:{maxAttempts:2,maxDelayMs:20}},
  {pagination:{...pagination,cursorParameter:"undeclared"}},
  {retry:{maxAttempts:4,maxDelayMs:20}},
 ])("refuses unsafe or unsupported response configuration %j",policy=>{
   expect(()=>parseNativeResponsePolicy(policy,"GET",[{name:"cursor",in:"query",schema:{type:"string"}}])).toThrow();
 });
 it.each(["POST","PUT","PATCH","DELETE"])("never enables automatic pagination or retry for %s effects",method=>{
   expect(()=>parseNativeResponsePolicy({pagination},method,[{name:"cursor",in:"query",schema:{type:"string"}}])).toThrow();
   expect(()=>parseNativeResponsePolicy({retry:{maxAttempts:2,maxDelayMs:0}},method,[])).toThrow();
 });
 it.each([
  {policy:{projection:{fields:{value:"/nested/echo"}}},raw:'{"nested":{"echo":"\\u0070rivate-pagination-token"}}'},
  {policy:{pagination},raw:'{"data":[{"\\u0070rivate-pagination-token":"hidden"}],"next":null}'},
  {policy:{pagination},raw:'{"data":[],"next":"\\u0070rivate-pagination-token"}'},
 ])("rejects decoded private credentials before receipts, model projection or cursor reuse %j",async({policy,raw})=>{
   const f=await fixture(policy,[{raw}]);const captured:unknown[]=[];
   await expect(executeNativeApiOperation(f.operation,{}, {...f.options,onResponse:async response=>{captured.push(response.body);}})).rejects.toMatchObject({code:"API_CREDENTIAL_REFLECTION"});
   expect(f.requests).toHaveLength(1);expect(captured).toHaveLength(0);
 });
 it("captures each received page privately before a later protocol failure",async()=>{
   const f=await fixture({pagination},[{body:{data:[1],next:"two"}},{body:{wrongShape:[2]}}]);const captured:unknown[]=[];
   await expect(executeNativeApiOperation(f.operation,{}, {...f.options,onResponse:async response=>{captured.push(response.body);}})).rejects.toMatchObject({code:"API_PAGINATION_INVALID"});
   expect(captured).toHaveLength(2);expect(JSON.stringify(captured)).toContain("wrongShape");expect(f.requests).toHaveLength(2);
 });
 it("does not expose unprojected data when a configured field is absent",async()=>{
  const f=await fixture({projection:{fields:{name:"/missing"}}},[{body:{secretBusinessField:"not projected"}}]);await expect(executeNativeApiOperation(f.operation,{},f.options)).rejects.toMatchObject({code:"API_RESPONSE_PROJECTION_INVALID"});expect(f.requests).toHaveLength(1);
 });
});
