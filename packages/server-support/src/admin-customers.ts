import {createHash} from "node:crypto";
import type {CustomerAction, CustomerOperationRequest} from "@kasitek-labs/contracts";

const labels: Record<CustomerAction,string> = {"webhook.replay":"Replay webhook","webhook.replay.approve":"Approve replay","task.cancel":"Request cancellation","ingress.retry":"Retry ingress","client.suspend":"Suspend client","client.resume":"Resume client"};
function invalid(message: string): never { throw Object.assign(new Error(message), {status:400,statusCode:400}); }
function text(value:unknown,name:string,max=160):string {
 if(typeof value!=="string"||!value.trim()||value.length>max||/[\u0000-\u001f]/.test(value))invalid(`Invalid ${name}`);
 return value.trim();
}
export function parseCustomerOperation(value:unknown):CustomerOperationRequest {
 if(!value||typeof value!=="object"||Array.isArray(value))invalid("Invalid operation");
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!["operationId","action","label","targetId","expected","reason","selection"].includes(k)))invalid("Unexpected operation field");
 const action=text(v.action,"action") as CustomerAction;
 if(!Object.hasOwn(labels,action))invalid("Unsupported action");
 if(!v.expected||typeof v.expected!=="object"||Array.isArray(v.expected))invalid("Expected state is required");
 const expected:Record<string,string|number>={};
 if(Object.keys(v.expected).length>12)invalid("Too many state fields");
 for(const [key,value] of Object.entries(v.expected)) {
  if(!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key)||["constructor","prototype"].includes(key))invalid("Invalid expected state");
  if(typeof value==="string")expected[key]=text(value,"expected state",240);
  else if(typeof value==="number"&&Number.isSafeInteger(value))expected[key]=value;
  else invalid("Invalid expected state");
 }
 const operationId=text(v.operationId,"operation ID",100);
 if(!/^[a-zA-Z0-9_-]{8,100}$/.test(operationId))invalid("Invalid operation ID");
 const result:CustomerOperationRequest={operationId,action,label:labels[action],targetId:text(v.targetId,"target"),reason:text(v.reason,"reason",500),expected};
 if(result.reason.length<8)invalid("Reason must contain at least 8 characters");
 if(v.selection!==undefined){
  if(!Array.isArray(v.selection)||v.selection.length<1||v.selection.length>100)invalid("Select between 1 and 100 ingress records");
  result.selection=[...new Set(v.selection.map(x=>text(x,"selection")))].sort();
  if(result.selection.length!==v.selection.length)invalid("Duplicate selection");
 }
 if(action==="ingress.retry"&&!result.selection)invalid("Ingress selection is required");
 if(action!=="ingress.retry"&&result.selection)invalid("Selection is only supported for ingress");
 return result;
}
export function parseCustomerPage(value:Record<string,unknown>={}) { 
 if(Object.keys(value).some(k=>!["cursor","limit"].includes(k)))invalid("Unexpected collection filter");
 const raw=value.limit??"50";
 if((typeof raw!=="string"&&typeof raw!=="number")||!/^\d{1,3}$/.test(String(raw))||Number(raw)<1||Number(raw)>100)invalid("Limit must be between 1 and 100");
 const cursor=value.cursor===undefined?null:text(value.cursor,"cursor",500);
 return {limit:Number(raw),cursor};
}
export function customerOperationDigest(actorId:string,product:string,customerId:string,request:CustomerOperationRequest):string {
 const expected=Object.fromEntries(Object.entries(request.expected).sort(([a],[b])=>a.localeCompare(b)));
 return createHash("sha256").update(JSON.stringify({actorId,product,customerId,operationId:request.operationId,action:request.action,targetId:request.targetId,reason:request.reason,expected,selection:request.selection??[]})).digest("hex");
}
export function customerOperationsEnabled(env:NodeJS.ProcessEnv=process.env):boolean {return env.NODE_ENV!=="production"&&env.KASITEK_CUSTOMER_OPERATIONS==="1";}
export function customerActionEnabled(action:CustomerAction,env:NodeJS.ProcessEnv=process.env):boolean {return customerOperationsEnabled(env)&&(env.KASITEK_CUSTOMER_ACTIONS??"").split(",").map(s=>s.trim()).includes(action);}
