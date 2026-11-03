import {z} from "zod";
import type {ProcedureApplicability,ProcedureReceipt,ProcedureReference,ProcedureRoute} from "./procedures";
import {PlatformError} from "./primitives";

export const afterHoursAssistance = Object.freeze({
 id:"after-hours-assistance",version:"1",title:"After-hours assistance",
 description:"Help a customer requesting a person while human support is closed.",
 requiredCapabilities:["support.request_assistance","support.update_assistance","support.get_status_v2"],
 playbook:`Help the customer naturally and briefly. The backend determines whether human support is closed. Use its local next-opening display when known; do not calculate relative waiting times. Unknown staff availability means unknown, not unavailable. Explain closure, offer help with the actual problem now, and record an explicit human-help request without requiring contact details. If the customer wants to leave a preferred email or phone, collect only missing details and explicit consent; use their message evidence. Existing conversation context should be reused. A saved request means only that staff can review it. Never promise that staff will reply at opening, within a time, or through this channel; never claim a notification, email or call was sent without that exact receipt. Explain that optional contact preferences are for manual staff use. Continue helping while the request is pending, and let the customer decline contact, withdraw follow-up or ask for no bot. Do not disclose workflow names, IDs, versions, receipt IDs, tool names or internal checklist status in ordinary customer replies. Do not narrate tool steps. You are the only conversational speaker. The request tool saves state and returns support facts; it sends no customer message. Save an explicit request for a person immediately, without waiting for contact details. In your own reply explain that support is closed and its next opening when known, offer to help now, and ask a useful next question. Ask for optional contact preferences naturally if the customer wants follow-up. Keep each reply brief. Do not recite uncertainty disclaimers unless asked. A delivered assistant reply is evidence of delivery only, not proof that you followed these conversational instructions. Suspending a workflow does not withdraw a saved human request; only the support tool can do that. Actual staff takeover or human-only preference stops automated replies. Completion comes from validated domain receipts, never your own checklist.`,
});
export function loadProcedure(reference:ProcedureReference){
 return resolveProcedure(reference).metadata;
}
export function discoverProcedures(selected:ProcedureReference[],ready:(reference:ProcedureReference)=>boolean){
 return selected.filter(ref=>definitions.has(`${ref.id}@${ref.version}`)&&ready(ref)).map(ref=>{const {playbook,...metadata}=loadProcedure(ref);return metadata;});
}
export function afterHoursProgress(route:ProcedureRoute|null,receipts:ProcedureReceipt[]){
 const confirmed=(kind:ProcedureReceipt["kind"])=>receipts.some(r=>r.kind===kind&&r.status==="confirmed");
 const required:ProcedureReceipt["kind"][]=["assistant_reply","customer_choice"];
 if(route==="callback")required.push("human_request");
 const missing:string[]=required.filter(kind=>!confirmed(kind));
 if(!z.enum(["callback","self_service","declined","withdrawn"]).safeParse(route).success)missing.unshift("customer_route");
 const hasUnknownEffects=receipts.some(r=>r.status==="unknown");
 return {missing,hasUnknownEffects,complete:missing.length===0&&!hasUnknownEffects};
}
const afterHoursFactsSchema=z.strictObject({afterHours:z.literal(true),nextOpeningAt:z.iso.datetime().nullable()});
export type ProcedureMetadata={id:string;version:string;title:string;description:string;requiredCapabilities:readonly string[];playbook:string};
export type ProcedureProgress={missing:string[];hasUnknownEffects:boolean;complete:boolean};
export type ProcedureDefinition={metadata:ProcedureMetadata;validateApplicability:(facts:ProcedureApplicability)=>boolean;progress:(route:ProcedureRoute|null,receipts:ProcedureReceipt[])=>ProcedureProgress};
const definitions:ReadonlyMap<string,ProcedureDefinition>=new Map([["after-hours-assistance@1",{metadata:afterHoursAssistance,validateApplicability:facts=>afterHoursFactsSchema.safeParse(facts).success,progress:afterHoursProgress}]]);
export function resolveProcedure(reference:ProcedureReference):ProcedureDefinition {
 const definition=definitions.get(`${reference.id}@${reference.version}`);
 if(!definition)throw new PlatformError("PROCEDURE_NOT_FOUND",404,"Procedure version is unavailable");
 return definition;
}
