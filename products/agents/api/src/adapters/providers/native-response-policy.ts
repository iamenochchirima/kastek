import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";

const pointer=z.string().max(512).refine(value=>{
  if(value!==""&&!value.startsWith("/"))return false;
  return value.split("/").slice(1).every(part=>!/~(?![01])/.test(part)&&!["__proto__","prototype","constructor"].includes(part.replace(/~1/g,"/").replace(/~0/g,"~")));
},"Use a bounded JSON Pointer without unsafe property names");
const fieldName=z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_.-]*$/).refine(value=>!["__proto__","prototype","constructor"].includes(value));
export const nativeResponsePolicySchema=z.strictObject({
  projection:z.strictObject({fields:z.record(fieldName,pointer).refine(fields=>Object.keys(fields).length>0&&Object.keys(fields).length<=16)}).optional(),
  pagination:z.strictObject({itemsPointer:pointer,nextCursorPointer:pointer,cursorParameter:fieldName,maxPages:z.number().int().min(1).max(8)}).optional(),
  retry:z.strictObject({maxAttempts:z.number().int().min(1).max(3),maxDelayMs:z.number().int().min(0).max(2000)}).optional(),
}).refine(value=>(value.pagination?.maxPages??1)*(value.retry?.maxAttempts??1)<=8,"At most eight physical requests are permitted");
export type NativeResponsePolicy=z.infer<typeof nativeResponsePolicySchema>;
export function parseNativeResponsePolicy(value:unknown,method:string,parameters:readonly {in:string;name:string;schema:unknown}[]):NativeResponsePolicy|undefined {
  if(value===undefined)return;
  const parsed=nativeResponsePolicySchema.safeParse(value);
  if(!parsed.success)throw new PlatformError("API_RESPONSE_POLICY_INVALID",400,"Response policy must use bounded JSON pointers, pages and retry limits");
  const policy=parsed.data;
  if((policy.pagination||(policy.retry?.maxAttempts??1)>1)&&method!=="GET")throw new PlatformError("API_RESPONSE_POLICY_INVALID",400,"Automatic pages and retries require a GET operation and explicit read authorization");
  if(policy.pagination){const parameter=parameters.find(parameter=>parameter.in==="query"&&parameter.name===policy.pagination!.cursorParameter);
    if(!parameter||!parameter.schema||typeof parameter.schema!=="object"||!("type" in parameter.schema)||parameter.schema.type!=="string")throw new PlatformError("API_RESPONSE_POLICY_INVALID",400,"The cursor must name a declared string query parameter");}
  return policy;
}
export function nativePhysicalRequestLimit(policy:NativeResponsePolicy|undefined):number {return(policy?.pagination?.maxPages??1)*(policy?.retry?.maxAttempts??1);}
export function readResponsePointer(value:unknown,pointer:string):unknown {
  let current=value;
  for(const part of pointer===""?[]:pointer.slice(1).split("/")){
    const key=part.replace(/~1/g,"/").replace(/~0/g,"~");
    if(!current||typeof current!=="object"||!Object.hasOwn(current,key))return undefined;
    current=(current as Record<string,unknown>)[key];
  }
  return current;
}
export function projectNativeResponse(value:unknown,policy:NativeResponsePolicy):unknown {
  return policy.projection?Object.fromEntries(Object.entries(policy.projection.fields).map(([name,path])=>{
    const selected=readResponsePointer(value,path);if(selected===undefined)throw new PlatformError("API_RESPONSE_PROJECTION_INVALID",502,"The provider response does not contain a selected response field");return[name,selected];
  })):value;
}
