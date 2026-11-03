import { randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { AGENCY_AGENT_COMMAND_PATH, AGENCY_AGENT_MODEL_PATH, type AgencyAgentCommand, type AgencyAgentModelConfiguration } from "@kasitek-labs/contracts";
import type { TenantContext } from "../context.js";
import { TenantError } from "../error.js";
import { capabilityDigest } from "./manifest.js";

export class AgencyExecutionClient {
  private readonly endpoint:string;
  private readonly key:ReturnType<typeof importPKCS8>;
  private readonly controlKey:ReturnType<typeof importPKCS8>|undefined;
  constructor(readonly options:{origin:string;privateKey:string;controlPrivateKey?:string;controlKeyId?:string;issuer:string;keyId:string;environment?:string;fetch?:typeof fetch}){
    const url=new URL(options.origin);
    if(url.username||url.password||url.search||url.hash||url.pathname!=="/"||url.protocol!=="https:"&&!(options.environment!=="production"&&url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname)))throw Error("Invalid Agents execution origin");
    this.endpoint=new URL(AGENCY_AGENT_COMMAND_PATH,url).href;this.key=importPKCS8(options.privateKey.replace(/\\n/g,"\n"),"RS256");
    this.controlKey=options.controlPrivateKey?importPKCS8(options.controlPrivateKey.replace(/\\n/g,"\n"),"RS256"):undefined;
  }
  async execute(command:AgencyAgentCommand):Promise<unknown>{
    return this.request(command,this.endpoint,this.key,this.options.keyId,"agency-api");
  }
  async configureModel(command:AgencyAgentModelConfiguration):Promise<unknown>{
    if(!this.controlKey)throw new TenantError(503,"Model setup unavailable");
    return this.request(command,new URL(AGENCY_AGENT_MODEL_PATH,this.options.origin).href,this.controlKey,this.options.controlKeyId??"agency-control-v1","agency-control");
  }
  private async request(command:AgencyAgentCommand|AgencyAgentModelConfiguration,endpoint:string,key:ReturnType<typeof importPKCS8>,keyId:string,subject:string):Promise<unknown>{
    const now=Math.floor(Date.now()/1000),token=await new SignJWT({product:"agencies",requestDigest:capabilityDigest(command)})
      .setProtectedHeader({alg:"RS256",kid:keyId}).setIssuer(this.options.issuer).setAudience("agents-product-api").setSubject(subject)
      .setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now+60).sign(await key);
    let response:Response;
    try{response=await(this.options.fetch??fetch)(endpoint,{method:"POST",redirect:"error",signal:AbortSignal.timeout(30000),
      headers:{"content-type":"application/json",authorization:"Bearer "+token,"x-correlation-id":command.requestId},body:JSON.stringify(command)});}
    catch{throw new TenantError(503,"Agent service unavailable");}
    const reader=response.body?.getReader(),decoder=new TextDecoder();let text="",bytes=0;
    if(reader)try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>2097152){await reader.cancel();throw new TenantError(502,"Agent response too large");}text+=decoder.decode(part.value,{stream:true});}}
    catch(error){if(error instanceof TenantError)throw error;throw new TenantError(503,"Agent response interrupted");}finally{reader.releaseLock();}
    text+=decoder.decode();let value:unknown;try{value=JSON.parse(text);}catch{throw new TenantError(502,"Invalid agent response");}
    if(!response.ok){const code=(value as {error?:{code?:unknown}})?.error?.code;throw new TenantError(response.status>=500?503:response.status,typeof code==="string"&&/^[A-Z_0-9]{1,80}$/.test(code)?code:"Agent request failed");}
    return value;
  }
}
const clients=new WeakMap<TenantContext,AgencyExecutionClient>();
export function agencyExecutionClient(context:TenantContext):AgencyExecutionClient{
  const previous=clients.get(context);if(previous)return previous;
  const env=context.config.env;if(!env.AGENTS_EXECUTION_URL||!env.AGENCY_AGENTS_PRIVATE_KEY)throw new TenantError(503,"Agent service unavailable");
  const client=new AgencyExecutionClient({origin:env.AGENTS_EXECUTION_URL,privateKey:env.AGENCY_AGENTS_PRIVATE_KEY,issuer:env.AGENCY_AGENTS_ISSUER??"https://agency.kasitek.co.za",
    controlPrivateKey:env.AGENCY_AGENTS_CONTROL_PRIVATE_KEY,controlKeyId:env.AGENCY_AGENTS_CONTROL_KEY_ID,
    keyId:env.AGENCY_AGENTS_KEY_ID??"agency-v1",environment:context.config.environment});clients.set(context,client);return client;
}
