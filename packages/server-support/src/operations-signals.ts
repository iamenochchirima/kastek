import type {OperationsSource,OperationsSnapshot,OperationsSignal,OperationsEvidence} from "@kasitek-labs/contracts";
const identifier=(value:unknown,max=160):value is string=>typeof value==="string"&&value.length>0&&value.length<=max&&/^[a-zA-Z0-9_.:-]+$/.test(value);
const timestamp=(v:unknown)=>typeof v==="string"&&/^\d{4}-\d\d-\d\dT/.test(v)&&Number.isFinite(Date.parse(v));
const count=(v:unknown)=>typeof v==="string"&&/^\d{1,30}$/.test(v);
const sources=["growth","agents","agency","analytics"];
export function parseOperationsSnapshot(value:unknown,source:OperationsSource,environment:string):OperationsSnapshot{
 if(!value||typeof value!=="object"||Array.isArray(value))throw Error("Invalid signal snapshot");
 const v=value as Record<string,any>;
 if(v.contractVersion!=="1"||v.source!==source||v.environment!==environment||!timestamp(v.observedAt)||!identifier(v.release,160)||!Array.isArray(v.signals)||v.signals.length>100)throw Error("Incompatible signal snapshot");
 const keys=new Set<string>();
 const signals:OperationsSignal[]=v.signals.map((s:Record<string,any>)=>{
  if(!s||!identifier(s.key,128)||!identifier(s.group,128)||!["available","unknown","unsupported","not_configured","no_activity"].includes(s.status)||!["count","seconds","basis_points"].includes(s.unit)||!["complete","partial","unknown"].includes(s.coverage)||!Array.isArray(s.evidence)||s.evidence.length>20)throw Error("Invalid signal");
  if(s.value!==null&&!count(s.value)||s.status==="available"&&s.value===null||s.denominator!==undefined&&s.denominator!==null&&!count(s.denominator))throw Error("Invalid signal count");
  if(s.unit==="basis_points"&&s.value!==null&&BigInt(s.value)>10000n)throw Error("Invalid signal rate");
  const key=s.key+":"+s.group;if(keys.has(key))throw Error("Duplicate signal");keys.add(key);
  const evidence:OperationsEvidence[]=s.evidence.map((e:Record<string,unknown>)=>{
   if(!e||!sources.includes(String(e.product))||!identifier(e.resourceType,80)||!identifier(e.resourceId,200)||e.customerId!==undefined&&!identifier(e.customerId,256)||e.operationId!==undefined&&!identifier(e.operationId,100)||e.code!==undefined&&!identifier(e.code,128))throw Error("Invalid signal evidence");
   return {product:e.product as OperationsSource,resourceType:String(e.resourceType),resourceId:String(e.resourceId),...(e.customerId?{customerId:String(e.customerId)}:{}),...(e.operationId?{operationId:String(e.operationId)}:{}),...(e.code?{code:String(e.code)}:{})};
  });
  if(s.windowStart!==undefined&&!timestamp(s.windowStart)||s.windowEnd!==undefined&&!timestamp(s.windowEnd)||s.windowStart&&s.windowEnd&&Date.parse(s.windowStart)>=Date.parse(s.windowEnd))throw Error("Invalid signal window");
  if(s.expectedIntervalSeconds!==undefined&&(!Number.isInteger(s.expectedIntervalSeconds)||s.expectedIntervalSeconds<1||s.expectedIntervalSeconds>86400))throw Error("Invalid heartbeat interval");
  if(s.code!==undefined&&!identifier(s.code,128))throw Error("Invalid signal code");
  return {key:s.key,group:s.group,status:s.status,value:s.value,unit:s.unit,coverage:s.coverage,evidence,...(s.expectedIntervalSeconds!==undefined?{expectedIntervalSeconds:s.expectedIntervalSeconds}:{}),...(s.denominator!==undefined?{denominator:s.denominator}:{}),...(s.windowStart?{windowStart:s.windowStart}:{}),...(s.windowEnd?{windowEnd:s.windowEnd}:{}),...(s.code?{code:s.code}:{})};
 });
 return {contractVersion:"1",source,environment,observedAt:new Date(v.observedAt).toISOString(),release:v.release,signals};
}
export async function readOperationsSnapshot(response:Response,source:OperationsSource,environment:string):Promise<OperationsSnapshot>{
 if(!response.ok||!response.body)throw Error("Signal source unavailable");
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>65536){await reader.cancel();throw Error("Signal response too large");}chunks.push(part.value);}
 return parseOperationsSnapshot(JSON.parse(Buffer.concat(chunks).toString("utf8")),source,environment);
}
