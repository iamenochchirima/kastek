import { z } from "zod";
import { canonicalJson,PlatformError,requestDigest } from "../../contracts/contracts";
export interface DeliveryTarget {id:string;label:string;url:string;resource:string}
export interface ReportPayload {schema:"report-delivery-v1";resource:string;title:string;report:{name:string;contentType:string;digest:string;contentBase64:string}}
export interface DeliveryReceipt {id:string;payloadDigest:string;acceptedAt:string}
export type DeliveryOutcome={state:"delivered";receipt:DeliveryReceipt}|{state:"absent"}|{state:"failed";errorCode:string}|{state:"uncertain";errorCode:string};
const targetSchema=z.strictObject({id:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),label:z.string().min(1).max(120),url:z.url(),resource:z.string().regex(/^[a-zA-Z0-9._:-]{1,120}$/)});
export function deliveryTargetsFromEnvironment(env:NodeJS.ProcessEnv=process.env):DeliveryTarget[]{
 try{return z.array(targetSchema).max(20).parse(JSON.parse(env.AGENTS_REPORT_DELIVERY_TARGETS??"[]")).map(target=>{
  const url=new URL(target.url);if(url.username||url.password||url.search||url.hash||url.pathname!=="/deliveries"||
   (url.protocol!=="https:"&&!(env.NODE_ENV!=="production"&&url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname))))throw Error();return target;
 });}catch{throw new PlatformError("DELIVERY_CONFIGURATION",503,"Report delivery configuration is invalid");}
}
const receiptSchema=z.strictObject({id:z.uuid(),payloadDigest:z.string().regex(/^[a-f0-9]{64}$/),acceptedAt:z.iso.datetime()});
export class ReportDeliveryHTTP {
 constructor(private readonly fetcher:typeof fetch=fetch){}
 async request(target:DeliveryTarget,apiKey:string,actionId:string,payload:ReportPayload|undefined,expectedDigest:string):Promise<DeliveryOutcome>{
  try{
   const url=payload?target.url:target.url+"/"+encodeURIComponent(actionId);
   const response=await this.fetcher(url,{method:payload?"POST":"GET",redirect:"error",signal:AbortSignal.timeout(15000),headers:{authorization:`Bearer ${apiKey}`,"x-report-resource":target.resource,...(payload?{"content-type":"application/json","idempotency-key":actionId,"x-payload-digest":expectedDigest}:{})},...(payload?{body:canonicalJson(payload)}:{})});
   if(!payload&&response.status===404)return{state:"absent"};
   if(response.status===401||response.status===403)return{state:"uncertain",errorCode:"DELIVERY_ACCESS_UNAVAILABLE"};
   if(payload&&response.status===409)return{state:"failed",errorCode:"DELIVERY_IDEMPOTENCY_CONFLICT"};
   if(!response.ok)return{state:"uncertain",errorCode:"DELIVERY_STATUS_UNKNOWN"};
   const length=Number(response.headers.get("content-length"));if(length>2048)return{state:"uncertain",errorCode:"DELIVERY_RECEIPT_INVALID"};
   const reader=response.body?.getReader();if(!reader)return{state:"uncertain",errorCode:"DELIVERY_RECEIPT_INVALID"};let total=0;const chunks:Uint8Array[]=[];
   while(true){const value=await reader.read();if(value.done)break;total+=value.value.length;if(total>2048){await reader.cancel();throw Error();}chunks.push(value.value);}
   const receipt=receiptSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
   if(receipt.id!==actionId||receipt.payloadDigest!==expectedDigest)throw Error();return{state:"delivered",receipt};
  }catch{return{state:"uncertain",errorCode:"DELIVERY_STATUS_UNKNOWN"};}
 }
}
export const reportPayloadDigest=(payload:ReportPayload)=>requestDigest(payload);
