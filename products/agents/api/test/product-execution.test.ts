import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http2";
import { createServer as httpServer } from "node:http";
import { createEndpointHandler } from "@restatedev/restate-sdk";
import { generateKeyPair, SignJWT } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProductExecutionAdapter } from "../src/adapters/products/product-execution";
import { defaultBusinessConfiguration, requestDigest, terminalTaskStates } from "../src/contracts/contracts";
import { AdmissionStore } from "../src/execution/admission/admission-store";
import { createBusinessWorkflow } from "../src/execution/business/business";
import { dispatchTasksOnce } from "../src/execution/lifecycle/dispatcher";
import { compilePublishedComposition } from "../src/execution/programs/publication";
import { publishedToolBindings } from "../src/capabilities/tool-definitions";
import { setupPlatformSchema } from "../src/composition/setup";

const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("delegated product execution contract with actual PostgreSQL/Restate",()=>{
  let admin:Pool,pool:Pool,keys:Awaited<ReturnType<typeof generateKeyPair>>;
  let worker:ReturnType<typeof createServer>,provider:ReturnType<typeof httpServer>,ingress:string,restAdmin:string;
  const database=`agents_products_${randomUUID().replaceAll("-","")}`,container=`agents-products-${randomUUID()}`;
  const observed:unknown[]=[];
  const docker=(...args:string[])=>execFileSync("docker",args,{encoding:"utf8",timeout:60000}).trim();
  async function until<T>(check:()=>Promise<T|false>,ms=20000):Promise<T>{const deadline=Date.now()+ms;while(Date.now()<deadline){const value=await check();if(value)return value;await new Promise(r=>setTimeout(r,40));}throw Error("Product fixture timed out");}
  beforeAll(async()=>{
    admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);
    const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);
    keys=await generateKeyPair("RS256");
    provider=httpServer(async(req,res)=>{let raw="";for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);observed.push(body);
      res.setHeader("content-type","application/json");res.end(JSON.stringify({choices:[{finish_reason:"stop",message:{role:"assistant",content:"Scoped product response"}}],usage:{prompt_tokens:40,completion_tokens:4}}));});
    await new Promise<void>(resolve=>provider.listen(0,"127.0.0.1",resolve));
    const providerUrl=`http://127.0.0.1:${(provider.address() as {port:number}).port}`;
    worker=createServer(createEndpointHandler({services:[createBusinessWorkflow(pool,{openRouterApiKey:"controlled-fixture",fetch:(_url,init)=>fetch(providerUrl,init)})]}));
    await new Promise<void>(resolve=>worker.listen(0,"0.0.0.0",resolve));
    docker("run","-d","--name",container,"--add-host=host.docker.internal:host-gateway","-p","127.0.0.1::8080","-p","127.0.0.1::9070","docker.restate.dev/restatedev/restate:1.7.13");
    ingress=`http://${docker("port",container,"8080/tcp")}`;restAdmin=`http://${docker("port",container,"9070/tcp")}`;
    await until(async()=>{try{return(await fetch(`${restAdmin}/health`)).ok;}catch{return false;}});
    const deployment=await fetch(`${restAdmin}/deployments`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({uri:`http://host.docker.internal:${(worker.address() as {port:number}).port}`})});
    expect(deployment.ok).toBe(true);
  },90000);
  afterAll(async()=>{
    try{docker("rm","-f",container);}catch{}
    if(worker)await new Promise<void>(r=>worker.close(()=>r()));
    if(provider)await new Promise<void>(r=>provider.close(()=>r()));
    await pool?.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);await admin.end();}
  });
  async function fixture(product:"growth"|"agencies"){
    const org=randomUUID(),agent=randomUUID(),version=randomUUID(),operator=randomUUID(),actor=randomUUID(),tenant=randomUUID();
    const configuration={...defaultBusinessConfiguration(),instructions:`${product.toUpperCase()}_PRIVATE_CONFIGURATION`};
    await pool.query("INSERT INTO agents_platform.accounts(id,issuer,subject,email,display_name) VALUES($1,'https://platform.example.test','fixture-operator',$2,'Fixture operator') ON CONFLICT(issuer,subject) DO NOTHING",[operator,`${operator}@example.test`]);
    const operatorId=(await pool.query("SELECT id FROM agents_platform.accounts WHERE issuer='https://platform.example.test' AND subject='fixture-operator'")).rows[0].id;
    await pool.query("INSERT INTO agents_platform.organizations(id,name) VALUES($1,$2)",[org,product]);
    await pool.query("INSERT INTO agents_platform.agents(id,organization_id,name,draft,created_by) VALUES($1,$2,'Product fixture',$3,$4)",[agent,org,configuration,operatorId]);
    await pool.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by,tool_bindings,effective_composition)
      VALUES($1,$2,$3,1,1,'business',$4,$5,$6,$7)`,[version,org,agent,configuration,operatorId,JSON.stringify(publishedToolBindings(configuration)),compilePublishedComposition(configuration,[])]);
    const issuer=`https://${product}.example.test/service`,actorIssuer=`https://${product}.example.test/users`,clientId=`${product}-execution`;
    await pool.query("INSERT INTO agents_platform.product_execution_tenants(product,tenant_id,organization_id,client_id,issuer) VALUES($1,$2,$3,$4,$5)",[product,tenant,org,clientId,issuer]);
    const store=new AdmissionStore(pool),adapter=new ProductExecutionAdapter(pool,{product,clientId,issuer,actorIssuer,publicKey:keys.publicKey},{admit:(db,input)=>store.admitTaskInTransaction(db,input)});
    async function assertion(input:string,overrides:Record<string,unknown>={}){
      const now=Math.floor(Date.now()/1000);
      return new SignJWT({product,tenantId:tenant,resourceId:`${product}-record-123`,versionId:version,actorIssuer,operations:["model.reply"],sourceRevisionIds:[],maxInputBytes:16384,maxOutputTokens:1024,rootTokenLimit:8192,inputDigest:requestDigest(input),...overrides})
        .setProtectedHeader({alg:"RS256"}).setIssuer(issuer).setAudience("agents-execution").setSubject(actor).setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now+240).sign(keys.privateKey);
    }
    return {org,agent,version,actor,tenant,adapter,assertion};
  }
  it("runs product-owned identities through the shared program without an Agents membership or shared context",async()=>{
    for(const product of ["growth","agencies"] as const){
      const f=await fixture(product),input=`${product} brief`,assertion=await f.assertion(input),requestKey=randomUUID();
      const first=await f.adapter.admit(assertion,{input,requestKey}),again=await f.adapter.admit(assertion,{input,requestKey});
      expect(again.task.id).toBe(first.task.id);
      await until(async()=>{await dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:restAdmin});const row=(await pool.query("SELECT state,output FROM agents_platform.tasks WHERE id=$1",[first.task.id])).rows[0];return terminalTaskStates.has(row.state)?row:false;}).then(row=>expect(row).toMatchObject({state:"completed",output:"Scoped product response"}));
      expect((await pool.query("SELECT count(*)::int n FROM agents_platform.memberships WHERE organization_id=$1",[f.org])).rows[0].n).toBe(0);
      expect((await pool.query("SELECT count(*)::int n FROM agents_platform.accounts WHERE subject=$1",[f.actor])).rows[0].n).toBe(0);
      expect(first.task.effective_composition.program.id).toBe("tool-directed");
    }
    expect(observed).toHaveLength(2);
    expect(JSON.stringify(observed[0])).toContain("GROWTH_PRIVATE_CONFIGURATION");expect(JSON.stringify(observed[0])).not.toContain("AGENCIES_PRIVATE_CONFIGURATION");
    expect(JSON.stringify(observed[1])).not.toContain("GROWTH_PRIVATE_CONFIGURATION");
  },30000);
  it("rejects wrong tenant, product, version and changed input before native admission",async()=>{
    const f=await fixture("growth");
    for(const overrides of [{tenantId:randomUUID()},{product:"agencies"},{versionId:randomUUID()}])await expect(f.adapter.admit(await f.assertion("brief",overrides),{input:"brief",requestKey:randomUUID()})).rejects.toBeDefined();
    await expect(f.adapter.admit(await f.assertion("brief"),{input:"changed",requestKey:randomUUID()})).rejects.toMatchObject({code:"PRODUCT_ASSERTION_SCOPE_DENIED"});
    const signed=await f.assertion("brief"),parts=signed.split(".");parts[2]=(parts[2]![0]==="a"?"b":"a")+parts[2]!.slice(1);
    await expect(f.adapter.admit(parts.join("."),{input:"brief",requestKey:randomUUID()})).rejects.toMatchObject({code:"PRODUCT_ASSERTION_INVALID"});
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.tasks WHERE organization_id=$1",[f.org])).rows[0].n).toBe(0);
  });
  it("rechecks delegated tenant authority after acceptance and refuses further work after revocation",async()=>{
    const f=await fixture("growth"),task=(await f.adapter.admit(await f.assertion("brief"),{input:"brief",requestKey:randomUUID()})).task;
    await pool.query("UPDATE agents_platform.product_execution_tenants SET revoked_at=now() WHERE organization_id=$1",[f.org]);
    const before=observed.length;
    await until(async()=>{await dispatchTasksOnce(pool,{ingressUrl:ingress,adminUrl:restAdmin});const row=(await pool.query("SELECT state,error_code FROM agents_platform.tasks WHERE id=$1",[task.id])).rows[0];return terminalTaskStates.has(row.state)?row:false;}).then(row=>expect(row).toMatchObject({state:"failed",error_code:"PRODUCT_AUTHORITY_INACTIVE"}));
    expect(observed.length).toBe(before);
  });
});
