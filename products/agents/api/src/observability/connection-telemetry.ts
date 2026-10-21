import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError } from "../contracts/contracts";

export const connectionFlowSchema=z.enum(["connect","authorize","callback","discover","refresh","credential_check","reconnect","rotate","disconnect","select","probe"]);
const providerSchema=z.enum(["mcp","native_api","google_calendar","model_provider","whatsapp","telegram","facebook","instagram"]);
export const connectionControlEventSchema=z.strictObject({
  event:z.literal("connection.lifecycle"),traceId:z.string().regex(/^[a-f0-9]{32}$/),
  provider:providerSchema,flow:connectionFlowSchema,outcome:z.enum(["completed","failed"]),
  durationMs:z.number().int().nonnegative().max(86400000),organizationId:z.uuid().optional(),connectionId:z.uuid().optional(),
  authorizationGeneration:z.number().int().positive().optional(),policyRevision:z.number().int().positive().optional(),
  failureClass:z.enum(["authorization","conflict","validation","provider","internal"]).optional(),
});
export type ConnectionControlEvent=z.infer<typeof connectionControlEventSchema>;
type Listener=(event:ConnectionControlEvent)=>void|Promise<void>;
const listeners=new Set<Listener>();
export function subscribeConnectionTelemetry(listener:Listener):()=>void {listeners.add(listener);return()=>{listeners.delete(listener);};}

/** Only this projection reaches logs/exporters; caught errors, input and provider responses never do. */
export function emitConnectionControlEvent(input:ConnectionControlEvent):void {
  const event=connectionControlEventSchema.parse(input);
  try {console.info(JSON.stringify(event));}catch {}
  for(const listener of listeners)try{const result=listener(event);if(result&&typeof result.catch==="function")void result.catch(()=>{});}catch {}
}
function failureClass(error:unknown):ConnectionControlEvent["failureClass"] {
  if(!(error instanceof PlatformError))return "internal";
  if(error.statusCode===401||error.statusCode===403||error.code==="AUTHENTICATION"||error.code.startsWith("OAUTH_"))return "authorization";
  if(error.statusCode===409)return "conflict";
  if(error.statusCode>=500)return "provider";
  return "validation";
}
type Identity={organizationId?:string;connectionId?:string;authorizationGeneration?:number;policyRevision?:number;reconnect?:boolean};
const authority=new AsyncLocalStorage<Identity>();
/** Capture metadata from rows already authorized/read by the operation. Never perform telemetry I/O. */
export function captureConnectionAuthority(row:{id?:string;organization_id?:string;generation?:number;policy_revision?:number;status?:string;verified_identity?:unknown;account_subject?:string|null}):void{
  const active=authority.getStore();if(!active)return;
  if(z.uuid().safeParse(row.id).success)active.connectionId=row.id;
  if(z.uuid().safeParse(row.organization_id).success)active.organizationId=row.organization_id;
  if(Number.isSafeInteger(row.generation)&&row.generation!>0){active.authorizationGeneration=row.generation;}
  if(row.status==="reconnect_required"||row.status==="disconnected"||row.verified_identity!=null||!!row.account_subject)active.reconnect=true;
  if(Number.isSafeInteger(row.policy_revision)&&row.policy_revision!>0)active.policyRevision=row.policy_revision;
}
/** Settlement never waits for a database lookup or exporter. Exporters receive a fixed projection. */
export async function observeConnectionControl<T>(_pool:Pool,provider:z.infer<typeof providerSchema>,flow:z.infer<typeof connectionFlowSchema>,identity:Identity,run:()=>Promise<T>):Promise<T>{
  const started=Date.now(),traceId=randomBytes(16).toString("hex"),context={...identity};
  return authority.run(context,async()=>{
    let outcome:ConnectionControlEvent["outcome"]="completed",failed:ConnectionControlEvent["failureClass"],result:T|undefined;
    try {result=await run();return result;}catch(error){outcome="failed";failed=failureClass(error);throw error;}
    finally {
      const durationMs=Math.min(86400000,Math.max(0,Date.now()-started));
      try {
        const value=result&&typeof result==="object"?result as Record<string,unknown>:{};
        const nested=value.connection&&typeof value.connection==="object"?value.connection as Record<string,unknown>:value;
        const organizationId=z.uuid().safeParse(context.organizationId??value.organizationId),connectionId=z.uuid().safeParse(context.connectionId??nested.id??value.connectionId);
        if(["discover","probe"].includes(flow)&&["failed","unsupported","authorization_required","credentials_required","reconnect_required"].includes(String(nested.status))){outcome="failed";failed=["authorization_required","credentials_required","reconnect_required"].includes(String(nested.status))?"authorization":"provider";}
        const generation=z.number().int().positive().safeParse(nested.generation??context.authorizationGeneration),policy=z.number().int().positive().safeParse(nested.policyRevision??context.policyRevision);
        emitConnectionControlEvent({event:"connection.lifecycle",traceId,provider,flow:flow==="authorize"&&context.reconnect?"reconnect":flow,outcome,durationMs,
          ...(organizationId.success?{organizationId:organizationId.data}:{}),...(connectionId.success?{connectionId:connectionId.data}:{}),
          ...(generation.success?{authorizationGeneration:generation.data}:{}),...(policy.success?{policyRevision:policy.data}:{}),...(failed?{failureClass:failed}:{})});
      }catch {/* Telemetry cannot turn settled work into a retry. */}
    }
  });
}
