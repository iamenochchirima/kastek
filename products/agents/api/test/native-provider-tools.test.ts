import { createServer,type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,it,vi } from "vitest";
import * as connectorRegistry from "../src/adapters/providers/connector-registry";
import { createNativeProviderCatalog,nativeProviderAdapterManifest,nativeProviderBindings,executeNativeProviderTool } from "../src/capabilities/connected-tools/native-provider-tools";
import { connectorConfiguration,type NativeConnectorConfiguration } from "../src/adapters/providers/connector-registry";
import { capabilityBindingSchema,adapterManifestSchema } from "../src/contracts/capability-catalog";
import { requestDigest } from "../src/contracts/contracts";

describe("managed native provider tools",()=>{
  const organizationId=randomUUID(),connectionId=randomUUID(),definition=connectorConfiguration("hubspot") as NativeConnectorConfiguration;
  const catalog=()=>createNativeProviderCatalog(definition,{id:randomUUID(),organizationId,connectionId,revision:1});
  const bindings=()=>nativeProviderBindings(catalog(),{accountId:randomUUID(),policyRevision:1,resource:{kind:"provider.account",id:"12345"}});
  let server:Server,base:string,requests:any[],contact:any,mode:string;
  beforeAll(async()=>{
    server=createServer(async(req,res)=>{
      let text="";for await(const part of req)text+=part;
      const body=JSON.parse(text);requests.push({url:req.url,body});res.setHeader("content-type","application/json");
      if(req.url!.endsWith("/search")){res.end(JSON.stringify({total:contact?1:0,results:contact?[contact]:[]}));return;}
      contact={id:"12",properties:body.properties};
      if(mode==="lost"){contact=undefined;req.socket.destroy();return;}
      res.statusCode=201;res.end(JSON.stringify(contact));
    });await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));base=`http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
  beforeEach(()=>{requests=[];contact=undefined;mode="ok";});
  const options=(beforeAttempt?:(phase:"read"|"effect"|"reconcile")=>Promise<void>)=>({organizationId,operationId:randomUUID(),deadlineAt:Date.now()+5000,testBaseUrl:base,beforeAttempt});
  it("pins installed code, connector authority and individual action schemas",()=>{
    const manifest=adapterManifestSchema.parse(nativeProviderAdapterManifest());expect(manifest).toMatchObject({id:"native-provider",release:"2",boundedSchemaValidation:true});
    const value=catalog();expect(value.tools).toHaveLength(2);expect(value.tools[0]!.managed).toMatchObject({providerId:"hubspot",connectorDigest:expect.stringMatching(/^[a-f0-9]{64}$/)});
    const result=bindings();expect(result.map(binding=>binding.definition.providerOperation)).toEqual(["contacts.search","contacts.create"]);
    expect(result[0]!.policy).toMatchObject({effect:"read",retry:"never"});expect(result[1]!.policy).toMatchObject({effect:"reviewed_write",approval:"exact_single_use",retry:"status_only"});
    expect(result[1]!.limits).toEqual({timeoutMs:30000,maxPhysicalAttempts:1,maxPhysicalRequests:3,maxResponseBytes:65536,maxModelResultBytes:8192});
  });
  it("projects operator search results and invokes read authority only",async()=>{
    contact={id:"12",properties:{email:"person@example.test",firstname:"Person",secret:"private"}};const phases:string[]=[];
    const result=await executeNativeProviderTool(bindings()[0]!,"fixture-token",{email:"person@example.test"},options(async phase=>{phases.push(phase);}));
    expect(result).toEqual({result:[{id:"12",email:"person@example.test",firstName:"Person"}],resultDigest:requestDigest([{id:"12",email:"person@example.test",firstName:"Person"}]),isError:false});expect(phases).toEqual(["read"]);
  });
  it("claims effect only immediately before an actual write",async()=>{
    const phases:string[]=[];const binding=bindings()[1]!;
    expect(await executeNativeProviderTool(binding,"fixture-token",{email:"person@example.test",firstName:"Person"},options(async phase=>{phases.push(phase);}))).toMatchObject({isError:false,result:{state:"confirmed",created:true}});expect(phases).toEqual(["read","effect"]);
    phases.length=0;expect(await executeNativeProviderTool(binding,"fixture-token",{email:"person@example.test",firstName:"Person"},options(async phase=>{phases.push(phase);}))).toMatchObject({result:{created:false}});expect(phases).toEqual(["read"]);
  });
  it("marks uncertain writes as errors and reconciles without another effect claim",async()=>{
    mode="lost";const phases:string[]=[];
    expect(await executeNativeProviderTool(bindings()[1]!,"fixture-token",{email:"person@example.test"},options(async phase=>{phases.push(phase);}))).toMatchObject({isError:true,result:{state:"uncertain",reason:"CONTACT_NOT_OBSERVED"}});expect(phases).toEqual(["read","effect","reconcile"]);expect(requests).toHaveLength(3);
  });
  it.each([{email:"person@example.test",url:"https://evil.test"},{email:"invalid"},{email:"person@example.test",firstName:{injected:"payload"}}])("rejects unexpected or invalid input before network use",async(args)=>{
    await expect(executeNativeProviderTool(bindings()[1]!,"fixture-token",args,options())).rejects.toThrow();expect(requests).toHaveLength(0);
  });
  it("rejects wrong tenant, tampered digest, operation and schema",async()=>{
    const binding=bindings()[0]!;
    await expect(executeNativeProviderTool(binding,"fixture-token",{email:"person@example.test"},{...options(),organizationId:randomUUID()})).rejects.toThrow();
    await expect(executeNativeProviderTool({...binding,digest:"a".repeat(64)},"fixture-token",{},options())).rejects.toThrow();
    for(const definition of [{...binding.definition,providerOperation:"contacts.delete"},{...binding.definition,inputSchema:{type:"object",properties:{},additionalProperties:true},inputDigest:requestDigest({type:"object",properties:{},additionalProperties:true})}]){
      const {digest:_,...rest}=binding,content={...rest,definition};
      await expect(executeNativeProviderTool({...content,digest:requestDigest(content)},"fixture-token",{},options())).rejects.toThrow();
    }
    expect(requests).toHaveLength(0);
  });
  it("rejects changed installed connector pins and missing resource identity",()=>{
    const value=catalog(),{digest:_,...rest}=value;
    const content={...rest,tools:value.tools.map(tool=>({...tool,managed:{providerId:"hubspot",connectorDigest:"a".repeat(64)}}))};
    expect(()=>nativeProviderBindings({...content,digest:requestDigest(content)},{policyRevision:1,resource:{kind:"provider.account",id:"123"}})).toThrow();
    expect(()=>nativeProviderBindings(value,{policyRevision:1,resource:{kind:"provider.account",id:""}})).toThrow();
    expect(capabilityBindingSchema.safeParse({...bindings()[0],resources:[]}).success).toBe(false);
  });
  it("uses the selected reviewed connector endpoint rather than the canonical provider record",async()=>{
    const regional={...definition,id:"hubspot-regional",apiBaseUrl:"https://api.hubapi.com/crm/objects/2026-03"};
    const original=connectorRegistry.connectorConfiguration;
    const lookup=vi.spyOn(connectorRegistry,"connectorConfiguration").mockImplementation((id,registry)=>id===regional.id?regional:original(id,registry));
    try{
      const selected=createNativeProviderCatalog(regional,{id:randomUUID(),organizationId,connectionId,revision:1});
      const binding=nativeProviderBindings(selected,{policyRevision:1,resource:{kind:"provider.account",id:"12345"}})[0]!;
      await executeNativeProviderTool(binding,"fixture-token",{email:"person@example.test"},options());
      expect(requests[0].url).toBe("/crm/objects/2026-03/contacts/search");
    }finally{lookup.mockRestore();}
  });
});
