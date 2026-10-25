import {randomUUID} from "node:crypto";
import {generateKeyPair,exportSPKI,SignJWT} from "jose";
import {beforeAll,describe,it,expect} from "vitest";
import {GrowthServiceAuth} from "../src/adapters/products/growth-service-auth";
import {GrowthActionClient} from "../src/adapters/products/growth-action-client";
import {growthFeatureConfiguration} from "../src/product/integrations/growth-features";
import {compilePublishedComposition} from "../src/execution/programs/publication";
import {defaultBusinessConfiguration,executionGrantSchema,assertGrantAuthority,requestDigest} from "../src/contracts/contracts";
import {registerProductAdapter} from "../src/capabilities/products/product-capabilities";
import {growthInstalledAdapterManifest} from "../src/execution/products/growth-runtime";
import type {GrowthAgentPublication,ProductCapabilityDescriptor,GrowthAgentCommand,GrowthAgentAction} from "@kasitek-labs/contracts";
const organizationId=randomUUID(),tenantId=randomUUID();
const descriptors:ProductCapabilityDescriptor[]=["workspace.read","draft.prepare"].map(operation=>({operation,revision:"1",description:operation,inputSchema:{type:"object",properties:{},additionalProperties:false},outputSchema:null,handlerRef:`growth.${operation}@1`,requiredAuthority:["feature.agents.manage"],evidence:"versioned_sources",policy:operation==="workspace.read"?{effect:"read",disclosure:"approved_resource_identifiers",retry:"safe_read",approval:"none",cancel:"stop_admission"}:{effect:"reviewed_write",disclosure:"exact_reviewed_payload",retry:"status_only",approval:"exact_single_use",cancel:"reconcile_claimed"},limits:{timeoutMs:10000,maxPhysicalAttempts:1,maxResponseBytes:131072,maxModelResultBytes:8192}}));
const adapter=registerProductAdapter(growthInstalledAdapterManifest,{handlers:descriptors.map(item=>item.handlerRef),async invoke(){throw new Error("Contract fixture does not execute tools");}});
const manifest={schemaVersion:1 as const,product:"growth",revision:"1",adapter,operations:descriptors};
const publication:GrowthAgentPublication={manifest:{...manifest,digest:requestDigest(manifest)},presets:(["assistant","research","content","campaigns"] as const).map(id=>({id,name:id,description:"Contract fixture",instructions:"Use authorized product tools.",operations:descriptors.map(item=>item.operation)})),policy:{revision:"1",optionalCapabilities:{knowledge:false,skills:false,memory:false,delegation:false,sandbox:false,workflows:false,connections:false}}};
const contentConfiguration=()=>growthFeatureConfiguration(publication,"content",organizationId,tenantId);
describe("Growth product contracts",()=>{
  let key:Awaited<ReturnType<typeof generateKeyPair>>,control:Awaited<ReturnType<typeof generateKeyPair>>,auth:GrowthServiceAuth;
  const issuer="https://growth.example.test",actor={issuer:issuer+"/identity",subject:randomUUID()};
  const command:GrowthAgentCommand={version:"1",requestId:randomUUID(),tenantId:randomUUID(),actor,operation:"features.list",input:{}};
  beforeAll(async()=>{key=await generateKeyPair("RS256",{extractable:true});control=await generateKeyPair("RS256",{extractable:true});
    auth=new GrowthServiceAuth({issuer,actorIssuer:actor.issuer,keys:{live:await exportSPKI(key.publicKey)},controlKeys:{control:await exportSPKI(control.publicKey)}});});
  async function token(cmd=command,options:{key?:typeof key;kid?:string;sub?:string;seconds?:number;actor?:string;jti?:string}={}) {
    const now=Math.floor(Date.now()/1000);
    return new SignJWT({product:"growth",requestDigest:requestDigest(cmd)}).setProtectedHeader({alg:"RS256",kid:options.kid??"live"})
      .setIssuer(issuer).setAudience("agents-product-api").setSubject(options.sub??"growth-api").setJti(options.jti??randomUUID())
      .setIssuedAt(now).setExpirationTime(now+(options.seconds??60)).sign((options.key??key).privateKey);
  }
  it("binds service authentication to the entire product/actor/request envelope",async()=>{
    const signed=await token();expect((await auth.verify(signed,command)).clientId).toBe("growth-api");
    for(const changed of [{...command,tenantId:randomUUID()},{...command,requestId:randomUUID()},{...command,actor:{...actor,subject:randomUUID()}}])
      await expect(auth.verify(signed,changed)).rejects.toMatchObject({code:"PRODUCT_SERVICE_DENIED"});
  });
  it("requires the installed human identity namespace and short lived temporal claims",async()=>{
    await expect(auth.verify(await token(command,{jti:"-".repeat(36)}),command)).rejects.toMatchObject({code:"PRODUCT_SERVICE_DENIED"});
    await expect(auth.verify(await token(command,{seconds:600}),command)).rejects.toMatchObject({code:"PRODUCT_SERVICE_DENIED"});
    await expect(auth.verify(await token(command,{seconds:-5}),command)).rejects.toMatchObject({code:"PRODUCT_SERVICE_DENIED"});
    const changed={...command,actor:{...actor,issuer:"https://another.example.test"}};
    await expect(auth.verify(await token(changed),changed)).rejects.toMatchObject({code:"PRODUCT_SERVICE_DENIED"});
  });
  it("separates control-plane keys from the Growth browser service client",async()=>{
    const configure:GrowthAgentCommand={...command,operation:"features.configure",input:{featureId:"content",configuration:contentConfiguration()}};
    await expect(auth.verify(await token(configure,{sub:"growth-control"}),configure)).rejects.toMatchObject({code:"PRODUCT_SERVICE_DENIED"});
    const signed=await token(configure,{key:control,kid:"control",sub:"growth-control"});
    expect((await auth.verify(signed,configure)).clientId).toBe("growth-control");
    await expect(auth.verify(await token(configure,{key:control,kid:"control",sub:"growth-api"}),configure)).rejects.toMatchObject({code:"PRODUCT_SERVICE_DENIED"});
  });
  it("keeps published program v1 unchanged and requires v3 for published product capabilities",()=>{
    const original=defaultBusinessConfiguration(),growth=contentConfiguration();
    expect(compilePublishedComposition(original,[]).program.version).toBe("1");
    expect(compilePublishedComposition(growth,[]).program.version).toBe("3");
    expect(growth.productBindings.map(binding=>binding.definition.providerOperation)).toEqual(["workspace.read","draft.prepare"]);
    expect(compilePublishedComposition(growth,[]).productBindings).toHaveLength(2);
    for(const version of ["1","2"])expect(()=>compilePublishedComposition({...growth,program:{id:"tool-directed",version}},[])).toThrow();
    expect(compilePublishedComposition(original,[]).program.digest).not.toBe(compilePublishedComposition(growth,[]).program.digest);
  });
  it("cannot give standalone or read-only agents Growth mutation authority",()=>{
    const config=contentConfiguration(),id=randomUUID(),authority={product:"agents" as const,organizationId:randomUUID(),resourceId:"content",callerClientId:"growth-api",principal:{kind:"human" as const,...actor}};
    const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:id,operations:["model.reply","product.read","product.write"],sourceRevisionIds:[],
      maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:config.context.maxInputTokens,rootTokenLimit:32000,expiresAt:new Date(Date.now()+60000).toISOString(),revokedAt:null});
    expect(()=>assertGrantAuthority(grant,authority,id,config)).toThrow();
    expect(()=>assertGrantAuthority({...grant,product:"growth",operations:["model.reply","product.read"]},{...authority,product:"growth"},id,config)).toThrow();
  });
  it("accepts bounded UTF-8 responses across split byte sequences and never follows redirects",async()=>{
    const {exportPKCS8}=await import("jose"),bytes=new TextEncoder().encode('{"authorized":true,"name":"é"}'),split=bytes.indexOf(0xc3)+1;
    let observed:RequestInit|undefined;
    const client=new GrowthActionClient({origin:"https://growth.example.test",issuer:"https://agents.example.test",keyId:"worker",privateKey:await exportPKCS8(key.privateKey),
      fetch:(async(_url,init)=>{observed=init;return new Response(new ReadableStream({start(c){c.enqueue(bytes.slice(0,split));c.enqueue(bytes.slice(split));c.close();}}),{status:200});}) as typeof fetch});
    const action:GrowthAgentAction={version:"1",requestId:randomUUID(),operationId:"authorization:test",tenantId:command.tenantId,actor,taskId:randomUUID(),conversationId:randomUUID(),featureId:"assistant",context:null,operation:"authorization.check",input:{}};
    expect(await client.call(action)).toMatchObject({authorized:true,name:"é"});expect(observed?.redirect).toBe("error");
    const interrupted=new GrowthActionClient({...client.options,fetch:(async()=>new Response(new ReadableStream({start(controller){controller.error(new TypeError("socket reset"));}}),{status:200})) as typeof fetch});
    await expect(interrupted.call(action)).rejects.toMatchObject({code:"GROWTH_ACTION_UNAVAILABLE",statusCode:503});
    expect(()=>new GrowthActionClient({origin:"http://169.254.169.254",issuer,keyId:"worker",privateKey:"irrelevant",environment:"production"})).toThrow("Invalid Growth product API origin");
  });
});
