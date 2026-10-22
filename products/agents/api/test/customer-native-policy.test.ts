import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { connectorConfiguration, type NativeConnectorConfiguration } from "../src/adapters/providers/connector-registry";
import { createNativeProviderCatalog, nativeProviderBindings } from "../src/capabilities/connected-tools/native-provider-tools";
import { assertCustomerNativeBindings, customerContactIntakeSchema } from "../src/capabilities/connected-tools/customer-native-policy";
import { registerInboxRoutes } from "../src/product/inbox/inbox-routes";
import { requestDigest } from "../src/contracts/contracts";
import { websiteWidgetScript } from "../src/adapters/channels/website/widget";

function fixture(operation="contacts.create") {
  const organizationId=randomUUID(),connectionId=randomUUID(),ownerAccountId=randomUUID();
  const definition=connectorConfiguration("hubspot") as NativeConnectorConfiguration;
  const catalog=createNativeProviderCatalog(definition,{id:randomUUID(),organizationId,connectionId,revision:1});
  const binding=nativeProviderBindings(catalog,{policyRevision:2,resource:{kind:"provider.account",id:"hub-123"}}).find(binding=>binding.definition.providerOperation===operation)!;
  const row={binding,current_connection_id:connectionId,organization_id:organizationId,account_id:ownerAccountId,profile_id:"hubspot-contacts-v1",policy_revision:2,
    resource_handles:[{kind:"provider.account",id:"hub-123"}],state:"active",expires_at:new Date(Date.now()+3600000),provider_id:"hubspot",account_subject:"hub-123",account_email:"owner@example.test",
    provider_status:"ready",sharing:"organization_service",selected_operations:[operation],binding_ids:[binding.id],granted_scopes:[...definition.auth.scopes,...definition.operations.flatMap(operation=>operation.scopes)]};
  const query=vi.fn(async()=>({rows:[row]}));return {row,binding,organizationId,ownerAccountId,query,db:{query} as unknown as PoolClient};
}

describe("customer contact intake authority",()=>{
  it("accepts only the current owner-shared reviewed creation capability",async()=>{
    const f=fixture();expect(await assertCustomerNativeBindings(f.db,f.organizationId,[f.binding.id])).toEqual([{binding:f.binding,ownerAccountId:f.ownerAccountId}]);
    const query=f.query.mock.calls[0] as unknown as [string,unknown[]];expect(query[0]).toContain("m.role='owner'");expect(query[1]).toEqual([f.binding.id,f.organizationId]);
  });
  it("rejects customer search even when the owner shared it",async()=>{
    const f=fixture("contacts.search");await expect(assertCustomerNativeBindings(f.db,f.organizationId,[f.binding.id])).rejects.toMatchObject({code:"CUSTOMER_NATIVE_AUTHORITY_DENIED"});
  });
  it.each([
    ["private sharing",{sharing:"private"}], ["revoked authorization",{state:"revoked"}], ["unready provider",{provider_status:"authorization_required"}],
    ["expired connection",{expires_at:new Date(0)}], ["missing identity",{account_subject:null}], ["missing verified account",{account_email:null}],
    ["unselected operation",{selected_operations:[]}], ["unselected binding",{binding_ids:[]}], ["changed policy",{policy_revision:3}],
    ["changed account resource",{resource_handles:[{kind:"provider.account",id:"other"}]}], ["revoked scope",{granted_scopes:[]}],
    ["wrong provider",{provider_id:"other"}], ["wrong connection",{current_connection_id:randomUUID()}],
  ])("denies %s",async(_label,patch)=>{
    const f=fixture();Object.assign(f.row,patch);await expect(assertCustomerNativeBindings(f.db,f.organizationId,[f.binding.id])).rejects.toMatchObject({code:"CUSTOMER_NATIVE_AUTHORITY_DENIED"});
  });
  it("rejects missing owner membership/binding and duplicate selections",async()=>{
    const f=fixture();f.query.mockResolvedValueOnce({rows:[]});await expect(assertCustomerNativeBindings(f.db,f.organizationId,[f.binding.id])).rejects.toThrow();
    await expect(assertCustomerNativeBindings(f.db,f.organizationId,[f.binding.id,f.binding.id])).rejects.toThrow();
  });
  it("rejects repinned definitions that disagree with installed registry or executable",async()=>{
    for(const alter of ["connector","adapter","policy"]){
      const f=fixture(),{digest:_,...binding}=f.binding;
      const changed=alter==="connector"?{...binding,definition:{...binding.definition,managed:{...binding.definition.managed!,connectorDigest:"a".repeat(64)}}}:
        alter==="adapter"?{...binding,adapter:{...binding.adapter,manifestDigest:"a".repeat(64)}}:
        {...binding,policy:{effect:"read",retry:"never",approval:"none",disclosure:"approved_resource_identifiers",cancel:"stop_admission"}};
      f.row.binding={...changed,digest:requestDigest(changed)} as typeof f.binding;
      await expect(assertCustomerNativeBindings(f.db,f.organizationId,[f.binding.id])).rejects.toThrow();
    }
  });
  it("accepts only exact contact intake fields and syntactically valid email",()=>{
    expect(customerContactIntakeSchema.parse({email:"customer@example.test",firstName:"Customer"})).toEqual({email:"customer@example.test",firstName:"Customer"});
    for(const input of [{email:"invalid"},{email:"customer@example.test",recordId:"foreign"},{email:"customer@example.test",firstName:"a\u0000b"}])expect(customerContactIntakeSchema.safeParse(input).success).toBe(false);
  });
  it("generates valid script syntax without executable HTML injection",()=>{
    expect(()=>new Function(websiteWidgetScript(randomUUID()))).not.toThrow();
    expect(websiteWidgetScript(randomUUID())).not.toContain("innerHTML");
  });
});

describe("website customer contact review routes",()=>{
  async function appFixture(state="automation_active") {
    const deploymentId=randomUUID(),sessionId=randomUUID(),conversationId=randomUUID(),executionConversationId=randomUUID(),organizationId=randomUUID(),taskId=randomUUID(),reviewId=randomUUID();
    const principal={kind:"visitor",deploymentId,sessionId};
    const listForPrincipal=vi.fn(async()=>[{id:reviewId,state:"pending",requestDigest:"a".repeat(64),arguments:{email:"customer@example.test"},operationName:"Save contact details",expiresAt:"2035-01-01T00:00:00Z"}]);
    const decideForPrincipal=vi.fn(async()=>({id:reviewId,state:"approved"}));
    const query=vi.fn(async()=>({rows:[{id:taskId}]})),readVisitor=vi.fn(async()=>({conversation:{id:conversationId,execution_conversation_id:executionConversationId,organization_id:organizationId,state},messages:[]}));
    const app=Fastify();registerInboxRoutes(app,{inbox:{pool:{query},readVisitor} as any,toolReviews:{listForPrincipal,decideForPrincipal} as any,
      resolveVisitor:async()=>({deploymentId,sessionId,organizationId} as any),resolveScope:async()=>{throw new Error("Staff authorization must not be used");}});
    await app.ready();return {app,principal,taskId,reviewId,query,readVisitor,listForPrincipal,decideForPrincipal,base:`/api/website/${deploymentId}/customer-conversations/${conversationId}/tool-reviews`};
  }
  it("resolves the visitor and exact execution conversation before listing or deciding",async()=>{
    const f=await appFixture();try {
      const list=await f.app.inject({method:"GET",url:f.base});expect(list.statusCode).toBe(200);expect(f.readVisitor).toHaveBeenCalled();expect(f.listForPrincipal).toHaveBeenCalledWith(f.taskId,f.principal);
      const query=f.query.mock.calls[0] as unknown as [string,unknown[]];expect(query[0]).toContain("t.principal=$2::jsonb");expect(query[1][1]).toBe(JSON.stringify(f.principal));
      const decision=await f.app.inject({method:"POST",url:`${f.base}/${f.reviewId}/decision`,payload:{decision:"approve",requestDigest:"a".repeat(64)}});expect(decision.statusCode).toBe(200);expect(f.decideForPrincipal).toHaveBeenCalledWith(f.taskId,f.principal,f.reviewId,{decision:"approve",requestDigest:"a".repeat(64)});
    } finally {await f.app.close();}
  });
  it.each(["human_owned","resolved","handoff_pending"])("denies confirmation while %s",async state=>{
    const f=await appFixture(state);try {const result=await f.app.inject({method:"POST",url:`${f.base}/${f.reviewId}/decision`,payload:{decision:"approve",requestDigest:"a".repeat(64)}});expect(result.statusCode).toBe(403);expect(f.decideForPrincipal).not.toHaveBeenCalled();}finally{await f.app.close();}
  });
});
