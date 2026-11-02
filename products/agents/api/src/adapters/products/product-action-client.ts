import { randomUUID } from "node:crypto";
import { importPKCS8,SignJWT } from "jose";
import type { ProductCapabilityInvocation,ProductCapabilityResult } from "@kasitek-labs/contracts";
import { PlatformError,requestDigest } from "../../contracts/contracts";
export interface ProductActionOptions {origin:string;issuer:string;keyId:string;privateKey:string;environment?:string;fetch?:typeof fetch}
/** The destination and signing material are installed configuration; descriptors cannot supply either. */
export class ProductActionClient {
  private readonly key:ReturnType<typeof importPKCS8>;private readonly endpoint:string;
  constructor(readonly options:ProductActionOptions){const url=new URL(options.origin);
    if(url.username||url.password||url.search||url.hash||url.pathname!=="/"||url.protocol!=="https:"&&!(options.environment!=="production"&&url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname)))throw Error("Invalid product API origin");
    this.endpoint=new URL("/internal/agents/capabilities",url).href;this.key=importPKCS8(options.privateKey,"RS256");}
  async invoke(command:ProductCapabilityInvocation,signal?:AbortSignal):Promise<ProductCapabilityResult>{
    const now=Math.floor(Date.now()/1000),token=await new SignJWT({requestDigest:requestDigest(command),product:command.authority.destinationProduct})
      .setProtectedHeader({alg:"RS256",kid:this.options.keyId}).setIssuer(this.options.issuer).setAudience("product-capability-actions").setSubject("agents-worker").setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now+60).sign(await this.key);
    const timeout=AbortSignal.timeout(30000),requestSignal=signal?AbortSignal.any([timeout,signal]):timeout;let response:Response;
    try{response=await(this.options.fetch??fetch)(this.endpoint,{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+token,"x-correlation-id":command.requestId},body:JSON.stringify(command),signal:requestSignal,redirect:"error"});}
    catch{throw new PlatformError("PRODUCT_ACTION_UNAVAILABLE",503,"The product operation has not been confirmed");}
    const reader=response.body?.getReader(),decoder=new TextDecoder();let text="",bytes=0;
    if(reader)try{for(;;){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;if(bytes>2097152){await reader.cancel();throw new PlatformError("PRODUCT_RESULT_LIMIT",502,"The product returned too much data");}text+=decoder.decode(part.value,{stream:true});}}
    catch(error){if(error instanceof PlatformError)throw error;throw new PlatformError("PRODUCT_ACTION_UNAVAILABLE",503,"The product response was interrupted");}finally{reader.releaseLock();}
    text+=decoder.decode();let value:unknown;try{value=JSON.parse(text);}catch{throw new PlatformError("PRODUCT_RESPONSE_INVALID",502,"The product returned an invalid result");}
    if(!response.ok){const candidate=(value as {code?:unknown;error?:{code?:unknown}})?.code??(value as {error?:{code?:unknown}})?.error?.code;
      throw new PlatformError(typeof candidate==="string"&&/^[A-Za-z0-9_]{1,80}$/.test(candidate)?candidate.toUpperCase():"PRODUCT_ACTION_DENIED",response.status>=500?503:response.status,"The product could not authorize or complete the operation");}
    return value as ProductCapabilityResult;
  }
}
