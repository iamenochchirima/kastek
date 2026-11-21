import {ProviderConnectionStore} from "../src/product/connections/provider-connections";
import {createServer,type Server} from "node:http";
import {randomBytes,randomUUID} from "node:crypto";
import {Pool} from "pg";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {setupPlatformSchema} from "../src/composition/setup";
import {PlatformStore} from "../src/product/agents/store";
import {ProviderServices} from "../src/product/connections/provider-services";
import type {ProviderOAuthPort} from "../src/product/connections/provider-oauth";
import {nativeProviderConnectors} from "../src/adapters/providers/connector-registry";
import {ConnectionVault} from "../src/infrastructure/vault";
import {transaction} from "../src/infrastructure/database";
import {dropClosedTestDatabase} from "./support/database-cleanup";
const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("native provider connection authority",()=>{
 const database=`agents_native_providers_${randomUUID().replaceAll("-","")}`,vault=new ConnectionVault("fixture",{fixture:randomBytes(32).toString("base64")});
 let admin:Pool,pool:Pool,platform:PlatformStore,server:Server,graphBase:string;
 beforeAll(async()=>{
  server=createServer((req,res)=>{res.setHeader("content-type","application/json");if(!req.headers.authorization?.startsWith("Bearer private-access-")){res.statusCode=401;res.end("{}");return;}
   if(req.url?.startsWith("/v1.0/me/calendars?")){res.end(JSON.stringify({value:[{id:"selected-calendar",name:"Bookings",canEdit:true},{id:"readonly",name:"Read only",canEdit:false}]}));return;}res.statusCode=404;res.end("{}");});
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));graphBase=`http://127.0.0.1:${(server.address() as {port:number}).port}/v1.0`;
  admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);platform=new PlatformStore(pool);
 });
 afterAll(async()=>{if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 async function fixture(){
  const account=await platform.ensureAccount({issuer:"https://fixture.example.test",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"}),organization=await platform.createOrganization(account.id,"Native fixture"),scope={accountId:account.id,organizationId:organization.id};
  const calls={complete:0,refresh:0},state={changedAccount:false,changedEmail:false};
  const oauth=(provider:string):ProviderOAuthPort=>({
   async begin(scopes=[]){const state=randomUUID()+randomUUID();return {state,nonce:randomUUID(),verifier:randomUUID(),authorizationUrl:`https://identity.example.test/authorize?state=${state}&scope=${encodeURIComponent(scopes.join(" "))}`};},
   async complete(_query,attempt){calls.complete++;return {accessToken:`private-access-${provider}`,refreshToken:`private-refresh-${provider}`,expiresAt:new Date(Date.now()+3600000).toISOString(),scopes:attempt.scopes??[],subject:`${provider}:account`,email:"owner@example.test"};},
   async refresh(_token,current){calls.refresh++;return {...current,subject:state.changedAccount?"other-account":current.subject,email:state.changedEmail?"changed@example.test":current.email,accessToken:`private-access-refreshed-${provider}`,expiresAt:new Date(Date.now()+3600000).toISOString()};}
  });
  const providers=new ProviderServices(pool,vault,{appUrl:"https://agents.example.test",environment:{},tests:Object.fromEntries(nativeProviderConnectors.map(definition=>[definition.id,{oauth:oauth(definition.id),...(definition.id==="microsoft-calendar"?{testApiBaseUrl:graphBase}:{})}]))});
  return {scope,providers,calls,state};
 }
 async function authorize(f:Awaited<ReturnType<typeof fixture>>,provider:string,id:string){const store=f.providers.store(provider),started=await store.authorize(f.scope,id);return `?state=${new URL(started.authorizationUrl).searchParams.get("state")}&code=fixture`;}
 async function connect(f:Awaited<ReturnType<typeof fixture>>,provider:string,operations?:string[]){const store=f.providers.store(provider),created=await store.create(f.scope,{name:provider,...(operations?{operations}:{})});await store.complete(f.scope.accountId,await authorize(f,provider,created.id));return {store,connection:await store.get(f.scope,created.id)};}
 it("selects Microsoft account, writable resource and explicit booking timezone",async()=>{
  const f=await fixture(),c=await connect(f,"microsoft-calendar",["calendar.availability","calendar.book"]);
  expect(c.connection).toMatchObject({providerId:"microsoft-calendar",status:"calendar_required",account:{subject:"microsoft-calendar:account"},sharing:"private"});
  expect((await c.store.calendars(f.scope,c.connection.id)).items).toEqual([{id:"selected-calendar",name:"Bookings",timeZone:"UTC",role:"writer"}]);
  await expect(c.store.selectCalendar(f.scope,c.connection.id,{generation:c.connection.generation,calendarId:"readonly"})).rejects.toMatchObject({code:"PROVIDER_CALENDAR_NOT_WRITABLE"});
  const selected=await c.store.selectCalendar(f.scope,c.connection.id,{generation:c.connection.generation,calendarId:"selected-calendar",timeZone:"Africa/Johannesburg"});expect(selected.calendar).toMatchObject({id:"selected-calendar",timeZone:"Africa/Johannesburg"});expect(selected.customerDeploymentEligible).toBe(false);
  const shared=await c.store.sharing(f.scope,selected.id,{generation:selected.generation,sharing:"organization_service"});expect(shared.customerDeploymentEligible).toBe(true);
  expect(await transaction(pool,db=>f.providers.resolveCalendar(db,f.scope,shared.id,shared.policyRevision,{requireOrganizationService:true}))).toMatchObject({providerId:"microsoft-calendar",calendarId:"selected-calendar",timeZone:"Africa/Johannesburg"});
 });
 it("creates only explicitly selected HubSpot bindings and never grants an agent authority",async()=>{
  const f=await fixture(),agentCount=(await pool.query("SELECT count(*)::int n FROM agents_platform.agents WHERE organization_id=$1",[f.scope.organizationId])).rows[0].n,c=await connect(f,"hubspot",["contacts.search","contacts.create"]);expect(c.connection).toMatchObject({status:"selection_required",bindingIds:[],customerDeploymentEligible:false});expect((await c.store.operationChoices(f.scope,c.connection.id)).operations).toHaveLength(2);
  const selected=await c.store.selectOperations(f.scope,c.connection.id,{generation:c.connection.generation,operationIds:["contacts.search"]});expect(selected).toMatchObject({status:"ready",operations:["contacts.search"],sharing:"private",customerDeploymentEligible:false});expect(selected.bindingIds).toHaveLength(1);
  const binding=(await pool.query("SELECT binding FROM agents_platform.capability_bindings WHERE id=$1",[selected.bindingIds[0]])).rows[0].binding;expect(binding.definition.providerOperation).toBe("contacts.search");expect(binding.policy.effect).toBe("read");
  expect((await pool.query("SELECT 1 FROM agents_platform.execution_grants WHERE organization_id=$1",[f.scope.organizationId])).rowCount).toBe(0);
  expect((await pool.query("SELECT count(*)::int n FROM agents_platform.agents WHERE organization_id=$1",[f.scope.organizationId])).rows[0].n).toBe(agentCount);
 });
 it("requires write scope step-up before creating a ready HubSpot write binding",async()=>{
  const f=await fixture(),c=await connect(f,"hubspot");const selected=await c.store.selectOperations(f.scope,c.connection.id,{generation:c.connection.generation,operationIds:["contacts.create"]});expect(selected).toMatchObject({status:"authorization_required",operations:["contacts.create"],bindingIds:[],readiness:{state:"unavailable"}});
  expect((await pool.query("SELECT 1 FROM agents_platform.capability_bindings WHERE connection_id=$1",[selected.id])).rowCount).toBe(0);await expect(transaction(pool,db=>c.store.resolveCredential(db,f.scope,selected.id,selected.policyRevision))).rejects.toMatchObject({code:"PROVIDER_AUTHORITY_CHANGED"});
  const started=await c.store.authorize(f.scope,selected.id);expect(new URL(started.authorizationUrl).searchParams.get("scope")).toContain("crm.objects.contacts.write");await c.store.complete(f.scope.accountId,`?state=${new URL(started.authorizationUrl).searchParams.get("state")}&code=fixture`);
  const current=await c.store.get(f.scope,selected.id);expect(current).toMatchObject({status:"selection_required",bindingIds:[],sharing:"private"});const enabled=await c.store.selectOperations(f.scope,current.id,{generation:current.generation,operationIds:["contacts.create"]});expect(enabled.status).toBe("ready");expect(enabled.bindingIds).toHaveLength(1);
  expect((await pool.query("SELECT binding FROM agents_platform.capability_bindings WHERE id=$1",[enabled.bindingIds[0]])).rows[0].binding.policy).toMatchObject({approval:"exact_single_use",retry:"status_only"});
 });
 it("creates idempotently and rejects changed replay or foreign operation ids",async()=>{
  const f=await fixture(),store=f.providers.store("hubspot"),input={name:"CRM",operationId:randomUUID()},first=await store.create(f.scope,input);expect((await store.create(f.scope,input)).id).toBe(first.id);await expect(store.create(f.scope,{...input,name:"Changed"})).rejects.toMatchObject({code:"CONNECTION_CHANGED"});await expect(store.create(f.scope,{name:"Invalid",operations:["calendar.book"]})).rejects.toMatchObject({code:"PROVIDER_OPERATION_INVALID"});
 });
 it("isolates records sharing an installed handler and profile",async()=>{
  const f=await fixture(),first=f.providers.store("hubspot");
  const second=new ProviderConnectionStore(pool,vault,{...first.options,definition:{...first.definition,id:"hubspot-secondary",name:"Secondary CRM"}});
  const a=await first.create(f.scope,{name:"First"}),b=await second.create(f.scope,{name:"Second"});
  expect((await first.list(f.scope)).map(item=>item.id)).toEqual([a.id]);expect((await second.list(f.scope)).map(item=>item.id)).toEqual([b.id]);
  expect((await first.catalogueConnections(f.scope)).map(item=>item.id)).toEqual([a.id]);expect((await second.catalogueConnections(f.scope)).map(item=>item.id)).toEqual([b.id]);
  await expect(first.get(f.scope,b.id)).rejects.toMatchObject({code:"PROVIDER_CONNECTION_NOT_FOUND"});await expect(second.get(f.scope,a.id)).rejects.toMatchObject({code:"PROVIDER_CONNECTION_NOT_FOUND"});
 });
 it("retains exact safe agent return and rejects external or backslash destinations",async()=>{
  const f=await fixture(),store=f.providers.store("hubspot"),created=await store.create(f.scope,{name:"Agent CRM"}),returnTo=`/app/agents/${randomUUID()}?section=configuration`;
  const started=await store.authorize(f.scope,created.id,{returnTo}),completed=await store.complete(f.scope.accountId,`?state=${new URL(started.authorizationUrl).searchParams.get("state")}&code=fixture`);
  expect(new URL(completed.redirectTo).origin).toBe("https://agents.example.test");expect(new URL(completed.redirectTo).searchParams.get("returnTo")).toBe(returnTo);
  for(const unsafe of ["https://other.example.test/app/agents/"+randomUUID(),"//other.example.test",`/app/agents/${randomUUID()}/\\other.example.test`])await expect(store.authorize(f.scope,created.id,{returnTo:unsafe})).rejects.toThrow();
 });
 it("rejects an in-flight old callback after a newer authorization starts",async()=>{
  const f=await fixture(),store=f.providers.store("hubspot"),created=await store.create(f.scope,{name:"Latest account"}),oauth=store.options.oauth!,original=oauth.complete.bind(oauth);
  let resume!:()=>void,entered!:()=>void;const exchangeEntered=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{resume=resolve;});let defer=true;
  oauth.complete=async(...args)=>{if(defer){defer=false;entered();await gate;}return original(...args);};
  const oldQuery=await authorize(f,"hubspot",created.id),oldPending=store.complete(f.scope.accountId,oldQuery),oldRejected=expect(oldPending).rejects.toMatchObject({code:"CONNECTION_CHANGED"});
  try{
   await exchangeEntered;const generation=(await store.get(f.scope,created.id)).generation,newQuery=await authorize(f,"hubspot",created.id);expect((await store.get(f.scope,created.id)).generation).toBe(generation);
   resume();await oldRejected;expect((await pool.query("SELECT 1 FROM agents_platform.connection_credentials WHERE connection_id=$1",[created.id])).rowCount).toBe(0);
   await store.complete(f.scope.accountId,newQuery);expect(await store.get(f.scope,created.id)).toMatchObject({status:"selection_required",account:{subject:"hubspot:account"}});
  }finally{resume();oauth.complete=original;}
 });
 it("isolates provider connections and callbacks without consuming a foreign attempt",async()=>{
  const f=await fixture(),hubspot=f.providers.store("hubspot"),microsoft=f.providers.store("microsoft-calendar"),created=await hubspot.create(f.scope,{name:"CRM"});await expect(microsoft.get(f.scope,created.id)).rejects.toMatchObject({code:"PROVIDER_CONNECTION_NOT_FOUND"});
  const query=await authorize(f,"hubspot",created.id);await expect(microsoft.complete(f.scope.accountId,query)).rejects.toMatchObject({code:"PROVIDER_CONFIGURATION_CHANGED"});expect(f.calls.complete).toBe(0);await hubspot.complete(f.scope.accountId,query);expect(f.calls.complete).toBe(1);await expect(hubspot.complete(f.scope.accountId,query)).rejects.toMatchObject({code:"PROVIDER_OAUTH_EXPIRED"});expect((await f.providers.forConnection(f.scope,created.id))?.definition.id).toBe("hubspot");
 });
 it("reports provider verification and credential expiry separately from local connection creation",async()=>{
  const f=await fixture(),store=f.providers.store("hubspot"),created=await store.create(f.scope,{name:"Verification"});expect(created).toMatchObject({authorizationVerifiedAt:null,credentialExpiresAt:null,grantedScopes:[]});
  await store.complete(f.scope.accountId,await authorize(f,"hubspot",created.id));const verified=await store.get(f.scope,created.id);expect(verified.authorizationVerifiedAt).toEqual(expect.any(String));expect(Date.parse(verified.credentialExpiresAt!)).toBeGreaterThan(Date.now());expect(verified.grantedScopes).toEqual(["crm.objects.contacts.read"]);
  await pool.query("UPDATE agents_platform.connections SET expires_at=now()-interval '1 minute' WHERE id=$1",[created.id]);expect(await store.get(f.scope,created.id)).toMatchObject({status:"reconnect_required",authorizationVerifiedAt:verified.authorizationVerifiedAt,readiness:{state:"unavailable",reasons:[{code:"PROVIDER_RECONNECT_REQUIRED"}]}});
 });
 it("refreshes without policy changes and rejects account-changing refresh",async()=>{
  const f=await fixture(),c=await connect(f,"hubspot");await pool.query("UPDATE agents_platform.native_provider_connections SET token_expires_at=now()-interval '1 minute' WHERE connection_id=$1",[c.connection.id]);await f.providers.ensureFresh(f.scope,c.connection.id);expect(f.calls.refresh).toBe(1);const refreshed=await c.store.get(f.scope,c.connection.id);expect(refreshed.policyRevision).toBe(c.connection.policyRevision);expect(refreshed.revision).toBe(c.connection.revision+1);
  await pool.query("UPDATE agents_platform.native_provider_connections SET token_expires_at=now()-interval '1 minute' WHERE connection_id=$1",[c.connection.id]);f.state.changedAccount=true;await expect(c.store.ensureCredentialFresh(f.scope,c.connection.id)).rejects.toMatchObject({code:"PROVIDER_ACCOUNT_CHANGED"});expect(await c.store.get(f.scope,c.connection.id)).toMatchObject({status:"reconnect_required",readiness:{state:"unavailable"}});
 });
 it("marks changed-email refresh reconnect-required immediately and clears its lease",async()=>{
  const f=await fixture(),c=await connect(f,"hubspot");await c.store.selectOperations(f.scope,c.connection.id,{generation:c.connection.generation,operationIds:["contacts.search"]});
  await pool.query("UPDATE agents_platform.native_provider_connections SET token_expires_at=now()-interval '1 minute' WHERE connection_id=$1",[c.connection.id]);f.state.changedEmail=true;
  await expect(c.store.ensureCredentialFresh(f.scope,c.connection.id)).rejects.toMatchObject({code:"PROVIDER_ACCOUNT_CHANGED"});expect(await c.store.get(f.scope,c.connection.id)).toMatchObject({status:"reconnect_required",readiness:{state:"unavailable"}});
  const row=(await pool.query("SELECT refresh_lease,refresh_started_at FROM agents_platform.native_provider_connections WHERE connection_id=$1",[c.connection.id])).rows[0];expect(row).toEqual({refresh_lease:null,refresh_started_at:null});expect(f.calls.refresh).toBe(1);
 });
 it("requires reconnect after abandoned refresh and clears bindings on reauthorization",async()=>{
  const f=await fixture(),c=await connect(f,"hubspot"),selected=await c.store.selectOperations(f.scope,c.connection.id,{generation:c.connection.generation,operationIds:["contacts.search"]});await pool.query("UPDATE agents_platform.native_provider_connections SET token_expires_at=now()-interval '1 minute',refresh_lease=$2,refresh_started_at=now()-interval '2 minutes' WHERE connection_id=$1",[selected.id,randomUUID()]);await expect(c.store.ensureCredentialFresh(f.scope,selected.id)).rejects.toMatchObject({code:"PROVIDER_RECONNECT_REQUIRED"});expect(f.calls.refresh).toBe(0);await c.store.complete(f.scope.accountId,await authorize(f,"hubspot",selected.id));expect(await c.store.get(f.scope,selected.id)).toMatchObject({status:"selection_required",bindingIds:[],sharing:"private"});
 });
 it("sanitizes management responses and encrypts stored credentials",async()=>{
  const f=await fixture(),c=await connect(f,"hubspot"),selected=await c.store.selectOperations(f.scope,c.connection.id,{generation:c.connection.generation,operationIds:["contacts.search"]});
  const management=JSON.stringify({connection:selected,choices:await c.store.operationChoices(f.scope,selected.id),catalogue:await f.providers.catalogueConnections(f.scope),readiness:f.providers.readiness()});for(const canary of ["private-access-","private-refresh-"])expect(management).not.toContain(canary);
  const stored=(await pool.query("SELECT envelope FROM agents_platform.connection_credentials WHERE connection_id=$1",[selected.id])).rows;for(const canary of ["private-access-","private-refresh-"])expect(JSON.stringify(stored)).not.toContain(canary);
  expect((await transaction(pool,db=>c.store.resolveCredential(db,f.scope,selected.id,selected.policyRevision))).authorization).toBe("private-access-hubspot");
 });
 it("denies other account scopes and revoked owners",async()=>{
  const f=await fixture(),other=await fixture(),c=await connect(f,"hubspot");await expect(c.store.get(other.scope,c.connection.id)).rejects.toMatchObject({code:"PROVIDER_CONNECTION_NOT_FOUND"});await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[f.scope.organizationId,f.scope.accountId]);await expect(c.store.get(f.scope,c.connection.id)).rejects.toMatchObject({code:"ACCESS_DENIED"});expect(await f.providers.catalogueConnections(f.scope)).toEqual([]);
 });
});
