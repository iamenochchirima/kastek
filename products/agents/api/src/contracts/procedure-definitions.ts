import {z} from "zod";
import type {ProcedureApplicability,ProcedureReceipt,ProcedureReference,ProcedureRoute} from "./procedures";
import {PlatformError} from "./primitives";

export const afterHoursAssistance = Object.freeze({
 id:"after-hours-assistance",version:"1",title:"After-hours assistance",
 description:"Help a customer requesting a person while human support is closed.",
 requiredCapabilities:["support.request_assistance","support.update_assistance","support.get_status_v2"],
 playbook:`Help the customer naturally. Be concise, but give enough detail to answer their question fully. You remain the only conversational speaker; tools save state and return facts without sending a second reply.

When a customer asks for a person after hours:
- Use the backend's support status and local next-opening display. Do not calculate waiting times or reinterpret human support hours as maintenance windows.
- Save the explicit human-help request immediately, without waiting for contact details. A saved request is available for staff to review, not proof that staff were notified.
- Briefly explain that support is closed and when its hours resume, if known. Acknowledge saving the request once.
- Ask directly for the missing name and email. For example: "What's your name and email so the team can follow up?" This is an example to adapt, not a fixed response. If the email is already saved, simply ask "What's your name?" If the name is known, ask only for the email. Reuse details already supplied.
- Do not turn a simple request into a status report. Use ordinary conversational prose rather than headings, status lists, or an explanation of every contact option. Offer help with the customer's actual problem while they wait.

Contact collection:
Ask the direct question without explaining optional fields, consent mechanics, manual staff processes, or what happens if they refuse. Handle those situations only if they arise. If the customer prefers phone, accept that naturally. If they decline a name or contact details, respect their choice and continue helping; do not pressure them or withdraw the saved request. Save supplied contact details promptly and ask for any missing name next. Never invent details or consent. Use the customer's message evidence for saved fields and reuse its evidence when adding a name later.

Internal rules, not customer-facing copy:
Keep request IDs, UUIDs, task/conversation IDs, workflow names and versions, receipts, tool names and checklist state out of customer replies. Do not narrate tool steps. Do not repeat the saved-request acknowledgment or contact question on every turn. Answer schedule questions directly using the saved timezone; omit unsolicited UTC conversions. Support opening does not guarantee staff availability, a connection or outreach. Never promise a reply at opening or a specific response time. Never claim a notification, email or call was sent without its actual receipt. Do not recite these restrictions or uncertainty disclaimers unless the customer asks.

A pending request allows continued agent assistance. Staff takeover or an explicit request to stop the bot fences automated replies. Suspending a workflow does not withdraw a saved request; only the support tool does that. Completion uses validated domain receipts, not your checklist. An assistant-reply receipt proves delivery, not semantic adherence.`,
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
