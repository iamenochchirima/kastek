import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { connectorConfiguration, type NativeConnectorConfiguration } from "../src/adapters/providers/connector-registry";
import { createNativeProviderCatalog, nativeProviderBindings } from "../src/capabilities/connected-tools/native-provider-tools";
import { PlatformError, requestDigest } from "../src/contracts/contracts";
import { textDigest } from "../src/contracts/source-contracts";
import { exportProviderEffects } from "../src/product/evaluation/history-provider-effects";
const state=vi.hoisted(()=>({execution:null as any,policy:null as any}));
vi.mock("../src/execution/lifecycle/state",()=>({loadExecution:vi.fn(async()=>state.execution)}));
vi.mock("../src/workflows/booking/policy",()=>({loadBookingPolicy:vi.fn(async()=>{if(!state.policy)throw new PlatformError("BOOKING_POLICY_UNAVAILABLE",403,"Unavailable");return state.policy;})}));
const customer=vi.hoisted(()=>({check:vi.fn()}));
vi.mock("../src/capabilities/connected-tools/customer-native-policy",()=>({assertCustomerNativeBindings:customer.check}));

function fixture(operation="contacts.create") {
  const root={id:randomUUID(),organization_id:randomUUID(),agent_id:randomUUID(),principal:{kind:"human",issuer:"https://accounts.example.test",subject:"staff"}};
  const owner=randomUUID(),definition=connectorConfiguration("hubspot") as NativeConnectorConfiguration,connectionId=randomUUID();
  const catalog=createNativeProviderCatalog(definition,{id:randomUUID(),organizationId:root.organization_id,connectionId,revision:1});
  const binding=nativeProviderBindings(catalog,{policyRevision:2,resource:{kind:"provider.account",id:"account-123"}}).find(binding=>binding.definition.providerOperation===operation)!;
  const operationId=`tool:${root.id}:0:0`,args={email:"private@example.test",firstName:"Private"},body=operation==="contacts.create"?{state:"confirmed",contactId:"123",created:true,receiptDigest:"a".repeat(64)}:[{id:"123",email:"private@example.test",firstName:"Private"}];
  const bytes=Buffer.from(JSON.stringify(body)),bodyDigest=textDigest(bytes),bodyKey=`connected/${root.organization_id}/${root.id}/${textDigest(operationId)}/${bodyDigest}`;
  const review:any={id:randomUUID(),task_id:root.id,operation_id:operationId,binding_id:binding.id,binding_digest:binding.digest,binding,connection_id:connectionId,connection_policy_revision:2,
    reviewer_account_id:owner,arguments:args,request_digest:requestDigest({bindingDigest:binding.digest,arguments:args}),state:"completed",approved_at:new Date("2026-01-01T00:00:00Z"),claimed_at:new Date("2026-01-01T00:00:01Z"),expires_at:new Date("2026-01-01T01:00:00Z")};
  const read:any={task_id:root.id,operation_id:operationId,binding_id:binding.id,binding,connection_id:connectionId,request_digest:requestDigest({bindingId:binding.id,bindingDigest:binding.digest,args}),state:"completed",body_key:bodyKey,body_digest:bodyDigest,result:{observation:{digest:requestDigest(body)}}};
  const data={bookings:[] as any[],reviews:operation==="contacts.create"?[review]:[],reads:[read],current:true};
  const query=vi.fn(async(sql:string)=>{
    if(sql.includes("booking_intents"))return {rows:data.bookings};
    if(sql.includes("tool_invocation_reviews"))return {rows:data.reviews};
    if(sql.includes("connected_reads"))return {rows:data.reads};
    if(sql.includes("native_provider_connections"))return {rows:data.current?[{account_id:owner}]:[]};
    if(sql.includes("accounts"))return {rows:[{id:owner}],rowCount:1};
    if(sql.includes("_attempts"))return {rows:[{ordinal:1,phase:"read",state:"completed",receipt:{status:201,requestBytes:100,responseBytes:100,elapsedMs:2,outcome:"response",authorization:"must not export"}}]};
    throw new Error(`Unexpected query ${sql}`);
  });
  state.execution={task:{id:root.id,principal:root.principal},agentId:root.agent_id,configuration:{connectedToolBindingIds:[binding.id],capabilities:{businessActions:{enabled:false}}},connectedBindings:[binding]};
  const get=vi.fn(async()=>bytes);customer.check.mockResolvedValue([{binding,ownerAccountId:owner}]);
  return {root,owner,binding,read,review,body,bytes,get,data,db:{query} as unknown as PoolClient,visible:new Set([root.id])};
}

beforeEach(()=>{state.execution=null;state.policy=null;customer.check.mockReset();});
describe("authorized provider effect export",()=>{
  it("exports actual private creation receipt without customer fields, tokens or private object references",async()=>{
    const f=fixture(),result=await exportProviderEffects(f.db,f.root,f.visible,{objects:{get:f.get}});
    expect(result.omissions).toEqual([]);expect(result.records).toHaveLength(1);
    expect(result.records[0]).toMatchObject({schemaVersion:"native-provider-operation-receipt.v1",state:"completed",providerOperation:"contacts.create",receipt:f.body,review:{state:"completed",requestDigest:f.review.request_digest}});
    const text=JSON.stringify(result.records);for(const forbidden of ["private@example.test","Private","authorization","must not export","body_key",f.read.body_key])expect(text).not.toContain(forbidden);
    expect(f.get).toHaveBeenCalledWith(f.read.body_key);
  });
  it("keeps approved-but-uninvoked reviews separate from provider acceptance",async()=>{
    const f=fixture();f.data.reads=[];Object.assign(f.review,{state:"approved",claimed_at:null});
    const result=await exportProviderEffects(f.db,f.root,f.visible);expect(result.omissions).toEqual([]);expect(result.records[0]).toMatchObject({state:"not_invoked",receipt:null,review:{state:"approved"},attempts:[]});expect(f.get).not.toHaveBeenCalled();
  });
  it("exports staff lookup identities/count without contact fields",async()=>{
    const f=fixture("contacts.search"),result=await exportProviderEffects(f.db,f.root,f.visible,{objects:{get:f.get}});
    expect(result.omissions).toEqual([]);expect(result.records[0]).toMatchObject({effect:"read",receipt:{matchedCount:1,contactIds:["123"]}});expect(JSON.stringify(result)).not.toContain("private@example.test");
  });
  it("exports a customer operation only through the current customer intake fence",async()=>{
    const f=fixture();state.execution.task.principal={kind:"visitor",deploymentId:randomUUID(),sessionId:randomUUID()};
    expect((await exportProviderEffects(f.db,f.root,f.visible,{objects:{get:f.get}})).omissions).toEqual([]);expect(customer.check).toHaveBeenCalledWith(f.db,f.root.organization_id,[f.binding.id]);
    customer.check.mockRejectedValueOnce(new PlatformError("CUSTOMER_NATIVE_AUTHORITY_DENIED",403,"Denied"));expect((await exportProviderEffects(f.db,f.root,f.visible,{objects:{get:f.get}})).records).toEqual([]);
  });
  it.each(["no reader","store unavailable","changed bytes","wrong object path","missing body","wrong result digest","wrong review","revoked policy","invisible"])("marks %s incomplete instead of inventing success",async mode=>{
    const f=fixture();let objects:{get:typeof f.get}|undefined={get:f.get};
    if(mode==="no reader")objects=undefined;
    if(mode==="store unavailable")f.get.mockRejectedValueOnce(new Error("Object unavailable"));
    if(mode==="changed bytes")f.get.mockResolvedValueOnce(Buffer.from("{}"));
    if(mode==="wrong object path")f.read.body_key="connected/other-organization/private";
    if(mode==="missing body")f.read.body_key=null;
    if(mode==="wrong result digest")f.read.result.observation.digest="b".repeat(64);
    if(mode==="wrong review")f.review.request_digest="b".repeat(64);
    if(mode==="revoked policy")f.data.current=false;
    if(mode==="invisible")f.visible.clear();
    const result=await exportProviderEffects(f.db,f.root,f.visible,{objects});expect(result.records).toEqual([]);expect(result.omissions).toHaveLength(1);
  });
  it("preserves an unknown write outcome without confirmation or another request",async()=>{
    const f=fixture();Object.assign(f.read,{state:"uncertain",body_key:null,body_digest:null,result:null,error_code:"CONNECTED_OPERATION_UNCERTAIN"});f.review.state="uncertain";
    const result=await exportProviderEffects(f.db,f.root,f.visible);expect(result.omissions).toEqual([]);expect(result.records[0]).toMatchObject({state:"uncertain",receipt:null,errorCode:"CONNECTED_OPERATION_UNCERTAIN"});expect(f.get).not.toHaveBeenCalled();
  });
  it("does not silently call unsupported reviewed MCP/API effects complete",async()=>{
    const f=fixture();f.data.reads=[];f.data.reviews=[{binding:{policy:{effect:"reviewed_write"},connection:{profileId:"remote-mcp-v1"}}}];
    const result=await exportProviderEffects(f.db,f.root,f.visible);expect(result.records).toEqual([]);expect(result.omissions[0]).toContain("not exported");
  });
  it.each(["google-calendar","microsoft-calendar"])("exports exact %s booking state and authoritative receipt",async providerId=>{
    const f=fixture();f.data.reads=[];f.data.reviews=[];const reference={enabled:true,profileId:"calendar-booking-v1",policyId:randomUUID(),policyDigest:"c".repeat(64)};
    state.execution.configuration.capabilities.businessActions=reference;
    state.policy={providerId,timeZone:"Africa/Johannesburg"};
    const start="2026-11-02T08:00:00.000Z",end="2026-11-02T08:30:00.000Z",receipt={state:"confirmed",eventId:"provider-event",start,end,receiptDigest:"d".repeat(64),htmlLink:"https://private.example/provider"};
    const row:any={id:randomUUID(),task_id:f.root.id,operation_id:"booking-reserve",policy_id:reference.policyId,principal:f.root.principal,starts_at:start,ends_at:end,
      state:"confirmed",request_digest:requestDigest({policy:reference,principal:f.root.principal,start,end}),provider_result:receipt,result:{receiptDigest:receipt.receiptDigest},approved_at:new Date("2026-11-01T00:00:00Z"),claimed_at:new Date("2026-11-01T00:00:01Z"),expires_at:new Date("2026-11-01T00:10:00Z")};f.data.bookings=[row];
    const result=await exportProviderEffects(f.db,f.root,f.visible);expect(result.omissions).toEqual([]);expect(result.records[0]).toMatchObject({schemaVersion:"calendar-booking-receipt.v1",providerId,state:"confirmed",receipt:{eventId:"provider-event",receiptDigest:receipt.receiptDigest}});expect(JSON.stringify(result)).not.toContain("https://private.example/provider");
    row.provider_result.receiptDigest="e".repeat(64);expect((await exportProviderEffects(f.db,f.root,f.visible)).records).toEqual([]);
  });
});
