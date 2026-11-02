import { randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import type { ProductCapabilityInvocation,ProductCapabilityResult,GrowthAgentAction, GrowthAgentActionOperation, GrowthAgentActionOutputs } from "@kasitek-labs/contracts";
import { PlatformError, requestDigest } from "../../contracts/contracts";

export interface GrowthActionOptions {
  origin: string; issuer: string; keyId: string; privateKey: string;
  environment?: string; fetch?: typeof fetch;
}
export class GrowthActionClient {
  private readonly key: ReturnType<typeof importPKCS8>;
  private readonly endpoint: string;
  constructor(readonly options: GrowthActionOptions) {
    const url = new URL(options.origin);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      url.protocol !== "https:" && !(options.environment !== "production" && url.protocol === "http:" && ["localhost","127.0.0.1","[::1]"].includes(url.hostname))) {
      throw new Error("Invalid Growth product API origin");
    }
    this.endpoint = new URL("/internal/agents/actions",url).href;
    this.key = importPKCS8(options.privateKey,"RS256");
  }
  async call<K extends GrowthAgentActionOperation>(command: GrowthAgentAction<K>): Promise<GrowthAgentActionOutputs[K]> {
    return this.request(command,this.endpoint,"growth-agent-actions") as Promise<GrowthAgentActionOutputs[K]>;
  }
  async invoke(command:ProductCapabilityInvocation,signal?:AbortSignal):Promise<ProductCapabilityResult> {
    return this.request(command,new URL("/internal/agents/capabilities",this.options.origin).href,"product-capability-actions",signal) as Promise<ProductCapabilityResult>;
  }
  private async request(command:{requestId:string;taskId:string;operationId:string},endpoint:string,audience:string,signal?:AbortSignal):Promise<unknown> {
    const now = Math.floor(Date.now()/1000);
    const token = await new SignJWT({ product:"growth",requestDigest:requestDigest(command) })
      .setProtectedHeader({alg:"RS256",kid:this.options.keyId}).setIssuer(this.options.issuer)
      .setAudience(audience).setSubject("agents-worker").setJti(randomUUID())
      .setIssuedAt(now).setExpirationTime(now+60).sign(await this.key);
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(endpoint,{
        method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+token,
          "x-correlation-id":command.requestId,"traceparent":`00-${requestDigest(command.taskId).slice(0,32)}-${requestDigest([command.taskId,command.operationId]).slice(0,16)}-01`},
        body:JSON.stringify(command),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(10000)]):AbortSignal.timeout(10000),redirect:"error",
      });
    } catch { throw new PlatformError("GROWTH_ACTION_UNAVAILABLE",503,"Growth is unavailable; the operation has not been confirmed"); }
    const reader=response.body?.getReader();
    let text="",bytes=0;const decoder=new TextDecoder();
    if(reader)try {
      for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;
        if(bytes>131072){await reader.cancel();throw new PlatformError("GROWTH_RESULT_LIMIT",502,"Growth returned too much data");}
        text+=decoder.decode(part.value,{stream:true});}
    } catch(error) {
      if(error instanceof PlatformError)throw error;
      throw new PlatformError("GROWTH_ACTION_UNAVAILABLE",503,"Growth response was interrupted; the operation has not been confirmed");
    } finally {reader.releaseLock();}
    text+=decoder.decode();
    let value: unknown;
    try {value=JSON.parse(text);}catch {throw new PlatformError("GROWTH_RESPONSE_INVALID",502,"Growth returned an invalid result");}
    if(!response.ok) {
      const body=value as {code?:unknown;error?:{code?:unknown}};
      const candidate=body.code??body.error?.code;
      const destinationCode=typeof candidate==="string"&&/^[a-zA-Z0-9_]{1,80}$/.test(candidate)?candidate.toUpperCase():"GROWTH_ACTION_DENIED";
      const code=[400,422].includes(response.status)&&destinationCode==="AGENT_TOOL_ARGUMENTS_INVALID"?"TOOL_ARGUMENTS_INVALID":destinationCode;
      throw new PlatformError(code,response.status>=500?503:response.status,"Growth could not authorize or complete this operation");
    }
    return value;
  }
}
export function growthActionClientFromEnvironment(env:NodeJS.ProcessEnv=process.env):GrowthActionClient|undefined {
  const configured=[env.GROWTH_PRODUCT_API_URL,env.AGENTS_PRODUCT_ACTION_PRIVATE_KEY];
  if(configured.every(value=>!value))return;
  if(configured.some(value=>!value))throw Error("Incomplete Growth action credentials");
  return new GrowthActionClient({origin:env.GROWTH_PRODUCT_API_URL!,privateKey:env.AGENTS_PRODUCT_ACTION_PRIVATE_KEY!,
    issuer:env.AGENTS_PRODUCT_ACTION_ISSUER??"https://agents.kasitek.co.za",keyId:env.AGENTS_PRODUCT_ACTION_KEY_ID??"agents-v1",environment:env.NODE_ENV});
}
