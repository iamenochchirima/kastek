import { createServer,type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,it } from "vitest";
import { HubSpotContactsClient,type HubSpotContactIntent } from "../src/adapters/providers/hubspot-contacts";

describe("bounded HubSpot Contacts adapter",()=>{
  let server:Server,base:string,mode:string,contact:any,requests:{url:string;body:any}[];
  const token="fixture-private-token";
  const intent:HubSpotContactIntent={organizationId:randomUUID(),requestId:randomUUID(),email:"person@example.test",firstName:"First",lastName:"Last",requestDigest:"a".repeat(64)};
  const record=()=>({id:"123",archived:false,properties:{email:intent.email,firstname:intent.firstName,lastname:intent.lastName,privateNotes:"not projected"}});
  beforeAll(async()=>{
    server=createServer(async(req,res)=>{
      let text="";for await(const chunk of req)text+=chunk;
      const body=JSON.parse(text);requests.push({url:req.url!,body});
      res.setHeader("content-type","application/json");
      if(req.headers.authorization!==`Bearer ${token}`){res.statusCode=401;res.end("{}");return;}
      if(mode==="redirect"){res.statusCode=307;res.setHeader("location","https://example.test/leak");res.end("{}");return;}
      if(mode==="reflection"){res.end(JSON.stringify({token}));return;}
      if(mode==="oversize"){res.end(JSON.stringify({data:"x".repeat(70000)}));return;}
      if(mode==="rate"&&req.url!.endsWith("/search")){res.statusCode=429;res.end("{}");return;}
      if(req.url!.endsWith("/search")){
        const results=contact?[contact]:[];
        res.end(JSON.stringify({total:mode==="ambiguous"?2:results.length,results,...(mode==="page"?{paging:{next:{after:"2"}}}:{})}));return;
      }
      if(mode==="conflict"){contact={...record(),properties:{...record().properties,firstname:"Different"}};res.statusCode=409;res.end("{}");return;}
      if(mode==="create-rate"){res.statusCode=429;res.end("{}");return;}
      contact={id:"123",archived:false,properties:body.properties};
      if(mode==="lost"||mode==="lost-missing"){if(mode==="lost-missing")contact=undefined;req.socket.destroy();return;}
      if(mode==="bad-receipt")contact.properties.email="other@example.test";
      res.statusCode=201;res.end(JSON.stringify(contact));
    });
    await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));base=`http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));});
  beforeEach(()=>{requests=[];mode="ok";contact=undefined;});
  const client=(beforeAttempt?:ConstructorParameters<typeof HubSpotContactsClient>[1]["beforeAttempt"])=>new HubSpotContactsClient(token,{deadlineAt:Date.now()+5000,testBaseUrl:base,beforeAttempt});
  it("searches one exact email with explicit narrow projection and no unrestricted pagination",async()=>{
    contact=record();expect(await client().searchContacts({email:"PERSON@example.test"})).toEqual([{id:"123",email:intent.email,firstName:"First",lastName:"Last"}]);
    expect(requests[0]).toEqual({url:"/crm/objects/2026-09/contacts/search",body:{filterGroups:[{filters:[{propertyName:"email",operator:"EQ",value:intent.email}]}],properties:["email","firstname","lastname"],limit:2}});
  });
  it("creates once with only allowed fields and confirms the exact provider receipt",async()=>{
    expect(await client().createContact(intent)).toMatchObject({state:"confirmed",created:true,contactId:"123",receiptDigest:expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect(requests).toHaveLength(2);expect(requests[1]!.body).toEqual({properties:{email:intent.email,firstname:"First",lastname:"Last"}});
  });
  it("reuses an existing matching contact without sending a create",async()=>{
    contact=record();expect(await client().createContact(intent)).toMatchObject({state:"confirmed",created:false});expect(requests).toHaveLength(1);
  });
  it("does not update an existing conflicting record",async()=>{
    contact=record();contact.properties.firstname="Someone";
    expect(await client().createContact(intent)).toMatchObject({state:"uncertain",reason:"CONTACT_INTENT_MISMATCH"});expect(requests).toHaveLength(1);
  });
  it("reconciles a lost acknowledgement without claiming attribution or sending twice",async()=>{
    mode="lost";expect(await client().createContact(intent)).toMatchObject({state:"confirmed",created:false});
    expect(requests.map(r=>r.url)).toEqual(["/crm/objects/2026-09/contacts/search","/crm/objects/2026-09/contacts","/crm/objects/2026-09/contacts/search"]);
  });
  it("keeps eventual-consistency misses uncertain and reconciliation read-only",async()=>{
    mode="lost-missing";expect(await client().createContact(intent)).toMatchObject({state:"uncertain",reason:"CONTACT_NOT_OBSERVED"});
    expect(await client().reconcileContact(intent)).toMatchObject({state:"uncertain",reason:"CONTACT_NOT_OBSERVED"});expect(requests.filter(r=>!r.url.endsWith("/search"))).toHaveLength(1);
  });
  it("refuses a race with a conflicting contact and mismatching create receipt",async()=>{
    mode="conflict";expect(await client().createContact(intent)).toMatchObject({state:"uncertain",reason:"CONTACT_INTENT_MISMATCH"});
    mode="bad-receipt";contact=undefined;expect(await client().createContact(intent)).toMatchObject({state:"uncertain",reason:"CONTACT_INTENT_MISMATCH"});
  });
  it.each(["ambiguous","page"])("rejects %s lookup before creation",async(value)=>{
    mode=value;contact=record();await expect(client().createContact(intent)).rejects.toMatchObject({code:"HUBSPOT_CONTACT_AMBIGUOUS"});expect(requests).toHaveLength(1);
  });
  it("checks live authority before creation and never sends after rejection",async()=>{
    await expect(client(async operation=>{if(operation==="create")throw Error("revoked");}).createContact(intent)).rejects.toThrow("revoked");expect(requests).toHaveLength(1);
  });
  it("does not retry rate limited reads or writes",async()=>{
    mode="rate";await expect(client().searchContacts({email:intent.email})).rejects.toMatchObject({code:"HUBSPOT_CONTACT_SEARCH_FAILED"});expect(requests).toHaveLength(1);
    mode="create-rate";requests=[];expect(await client().createContact(intent)).toMatchObject({state:"uncertain",reason:"CREATE_HTTP_429"});expect(requests).toHaveLength(2);
  });
  it.each(["reflection","oversize","redirect"])("rejects unsafe %s responses",async(value)=>{
    mode=value;await expect(client().searchContacts({email:intent.email})).rejects.toThrow();expect(requests).toHaveLength(1);
  });
  it("validates input and fixture endpoints before sending",async()=>{
    await expect(client().createContact({...intent,email:"invalid"})).rejects.toThrow();
    expect(()=>new HubSpotContactsClient(token,{deadlineAt:Date.now()+5000,testBaseUrl:"https://example.test"})).toThrow();
    expect(()=>new HubSpotContactsClient(token,{deadlineAt:Date.now()+5000,testBaseUrl:base,apiBaseUrl:"http://127.0.0.1/private"})).toThrow();
    expect(()=>new HubSpotContactsClient(token,{deadlineAt:Date.now()+5000,testBaseUrl:base,apiBaseUrl:"https://credential@example.test/crm"})).toThrow();
    expect(requests).toHaveLength(0);
  });
});
