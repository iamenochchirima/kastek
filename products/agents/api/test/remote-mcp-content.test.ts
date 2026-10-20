import {randomUUID} from "node:crypto";
import {createServer,type Server} from "node:http";
import {afterEach,describe,expect,it} from "vitest";
import {discoverRemoteMcp,executeRemoteMcpTool,expandRemoteResourceTemplate,invalidateRemoteMcpCatalogCache,remoteMcpContentOperations,type RemoteMcpEndpoint} from "../src/adapters/providers/remote-mcp";

const servers:Server[]=[];
afterEach(async()=>{invalidateRemoteMcpCatalogCache();for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}});
async function fixture(modern=false){
  const calls:{method:string;params:Record<string,unknown>}[]=[],state={drift:false,capabilities:true,foreignUri:false,inputRequired:false,ttlMs:30000};
  const server=createServer(async(request,response)=>{
    if(request.method!=="POST"||request.url!=="/mcp")return response.writeHead(405).end();
    let text="";for await(const chunk of request)text+=chunk;const rpc=JSON.parse(text);calls.push({method:rpc.method,params:rpc.params??{}});response.setHeader("content-type","application/json");
    const result=(value:Record<string,unknown>)=>response.end(JSON.stringify({jsonrpc:"2.0",id:rpc.id,result:{...(modern?{resultType:"complete"}:{}),...value}}));
    const capabilities=state.capabilities?{resources:{},prompts:{},tools:{}}:{tools:{}};
    const hints=modern?{ttlMs:state.ttlMs,cacheScope:"private"}:{};
    if(rpc.method==="server/discover")return modern?result({supportedVersions:["2026-07-28"],capabilities}):response.end(JSON.stringify({jsonrpc:"2.0",id:rpc.id,error:{code:-32601,message:"Legacy fixture"}}));
    if(rpc.method==="initialize")return result({protocolVersion:"2025-11-25",capabilities,serverInfo:{name:"content-fixture",version:"1"}});
    if(rpc.method==="notifications/initialized")return response.writeHead(202).end();
    if(rpc.method==="tools/list")return result({...hints,tools:[]});
    if(rpc.method==="resources/list")return result({...hints,resources:[{uri:"file:///selected-policy",name:"Policy",description:state.drift?"Changed policy descriptor":"Selected policy"}]});
    if(rpc.method==="resources/templates/list")return result({...hints,resourceTemplates:[{uriTemplate:"fixture://policy/{name}",name:"Named policy"}]});
    if(rpc.method==="prompts/list")return result({...hints,prompts:[{name:"review_policy",description:"External review prompt",arguments:[{name:"topic",required:true}]}]});
    if(state.inputRequired&&["resources/read","prompts/get"].includes(rpc.method))return result({resultType:"input_required",inputRequests:{root:{method:"roots/list",params:{}}}});
    if(rpc.method==="resources/read")return result({...hints,contents:[{uri:state.foreignUri?"file:///unselected-private-file":rpc.params.uri,mimeType:"text/plain",text:"Authoritative selected policy"},{uri:rpc.params.uri,mimeType:"image/png",blob:"AA=="}]});
    if(rpc.method==="prompts/get")return result({messages:[{role:"assistant",content:{type:"text",text:`External instructions for ${rpc.params.arguments.topic}`}},{role:"user",content:{type:"image",mimeType:"image/png",data:"AA=="}}]});
    return response.writeHead(400).end("{}");
  });servers.push(server);await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const endpoint:RemoteMcpEndpoint={endpoint:`http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`,deadlineAt:Date.now()+30000,testLoopback:true,
    effectiveAuthorityDigest:"a".repeat(64),cacheScope:{organizationId:randomUUID(),accountId:randomUUID(),connectionId:randomUUID(),credentialRevision:1,policyRevision:1,generation:1}};
  return {endpoint,calls,state};
}
describe("scoped MCP resources, templates and prompts",()=>{
  it.each([false,true])("reads exact opaque resources and preserves typed bytes without fetching their URI, modern=%s",async modern=>{
    const f=await fixture(modern),inventory=await discoverRemoteMcp(f.endpoint),resource=remoteMcpContentOperations(inventory).find(tool=>tool.target?.kind==="resource")!;
    const result=await executeRemoteMcpTool(f.endpoint,resource,{});expect(result.rpcMethod).toBe("resources/read");expect(result.content).toMatchObject([{type:"resource",resource:{uri:"file:///selected-policy",text:"Authoritative selected policy"}},{type:"resource",resource:{blob:"AA=="}}]);
    const lists=f.calls.filter(call=>call.method==="resources/list").length;await executeRemoteMcpTool(f.endpoint,resource,{});expect(f.calls.filter(call=>call.method==="resources/list")).toHaveLength(lists);expect(f.calls.filter(call=>call.method==="resources/read")).toHaveLength(2);
    expect(f.calls.filter(call=>call.method==="tools/call")).toHaveLength(0);
  },20000);
  it.each([false,true])("keeps prompt roles as external result data and validates declared arguments, modern=%s",async modern=>{
    const f=await fixture(modern),inventory=await discoverRemoteMcp(f.endpoint),prompt=remoteMcpContentOperations(inventory).find(tool=>tool.target?.kind==="prompt")!;
    const result=await executeRemoteMcpTool(f.endpoint,prompt,{topic:"refund policy"});expect(result.rpcMethod).toBe("prompts/get");expect(result.structuredContent).toMatchObject({kind:"external_prompt",messages:[{role:"assistant"},{role:"user"}]});
    expect(result.content).toMatchObject([{type:"text",_meta:{kasitekExternalPromptRole:"assistant"}},{type:"image",data:"AA=="}]);
    await expect(executeRemoteMcpTool(f.endpoint,prompt,{topic:"valid",undeclared:"forbidden"})).rejects.toMatchObject({code:"MCP_ARGUMENTS_INVALID"});expect(f.calls.filter(call=>call.method==="prompts/get")).toHaveLength(1);
  },20000);
  it("expands only fixed approved scalar template values and denies changed URI or model variables",async()=>{
    const f=await fixture(),inventory=await discoverRemoteMcp(f.endpoint),template=remoteMcpContentOperations(inventory).find(tool=>tool.target?.kind==="template")!;
    if(template.target?.kind!=="template")throw Error("Missing template");const values={name:"reviewed value"},uri=await expandRemoteResourceTemplate(template.target,values);
    expect(uri).toBe("fixture://policy/reviewed%20value");const selected={...template,templateArguments:values,resourceUri:uri};await executeRemoteMcpTool(f.endpoint,selected,{});
    await expect(executeRemoteMcpTool(f.endpoint,{...selected,resourceUri:"fixture://policy/another"},{})).rejects.toMatchObject({code:"MCP_RESOURCE_SCOPE_DENIED"});
    await expect(executeRemoteMcpTool(f.endpoint,selected,{name:"model-chosen"})).rejects.toMatchObject({code:"MCP_ARGUMENTS_INVALID"});expect(f.calls.filter(call=>call.method==="resources/read")).toHaveLength(1);
  },20000);
  it("partitions list caches by content category and honors modern zero TTL",async()=>{
    const f=await fixture(true),inventory=await discoverRemoteMcp(f.endpoint),operations=remoteMcpContentOperations(inventory),resource=operations.find(tool=>tool.target?.kind==="resource")!,prompt=operations.find(tool=>tool.target?.kind==="prompt")!;
    await executeRemoteMcpTool(f.endpoint,resource,{});await executeRemoteMcpTool(f.endpoint,prompt,{topic:"selected"});const lists=f.calls.filter(call=>call.method==="resources/list").length;
    await executeRemoteMcpTool(f.endpoint,resource,{});expect(f.calls.filter(call=>call.method==="resources/list")).toHaveLength(lists);
    f.state.ttlMs=0;const uncached={...f.endpoint,cacheScope:{...f.endpoint.cacheScope!,generation:2}};
    await executeRemoteMcpTool(uncached,resource,{});await executeRemoteMcpTool(uncached,resource,{});expect(f.calls.filter(call=>call.method==="resources/list")).toHaveLength(lists+2);
  },20000);
  it("refuses foreign returned resources, descriptor drift, missing capability and unavailable input requests",async()=>{
    const f=await fixture(true),inventory=await discoverRemoteMcp(f.endpoint),resource=remoteMcpContentOperations(inventory).find(tool=>tool.target?.kind==="resource")!;
    f.state.foreignUri=true;await expect(executeRemoteMcpTool(f.endpoint,resource,{})).rejects.toMatchObject({code:"MCP_RESOURCE_SCOPE_DENIED"});f.state.foreignUri=false;
    f.state.drift=true;await discoverRemoteMcp(f.endpoint);await expect(executeRemoteMcpTool(f.endpoint,resource,{})).rejects.toMatchObject({code:"MCP_DEFINITION_DRIFT"});f.state.drift=false;
    f.state.capabilities=false;await expect(executeRemoteMcpTool(f.endpoint,resource,{})).rejects.toMatchObject({code:"MCP_CAPABILITY_UNAVAILABLE"});f.state.capabilities=true;
    f.state.inputRequired=true;await expect(executeRemoteMcpTool(f.endpoint,resource,{})).rejects.toMatchObject({code:"MCP_CLIENT_CAPABILITY_UNSUPPORTED"});
  },25000);
  it("diagnoses unsupported URI template operators without enabling them",()=>{
    const operations=remoteMcpContentOperations({tools:[],resources:[],prompts:[],resourceTemplates:[{name:"Reserved expansion",uriTemplate:"fixture://policy/{+path}",descriptor:{name:"Reserved expansion",uriTemplate:"fixture://policy/{+path}"}}]});
    expect(operations[0]).toMatchObject({compatible:false,diagnostics:[{code:"MCP_TEMPLATE_UNSUPPORTED"}]});
  });
});
