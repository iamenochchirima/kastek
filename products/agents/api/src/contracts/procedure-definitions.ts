import {z} from "zod";
import type {ProcedureApplicability,ProcedureReceipt,ProcedureReference,ProcedureRoute} from "./procedures";
import {PlatformError} from "./primitives";

export const afterHoursAssistance = Object.freeze({
 id:"after-hours-assistance",version:"1",title:"After-hours assistance",
 description:"Help a customer requesting a person while human support is closed.",
 requiredCapabilities:["support.request_assistance","support.update_assistance","support.get_status_v2"],
 prerequisites:["support.request_assistance","support.update_assistance","support.get_status_v2"],
 waits:[{kind:"customer_choice",description:"The customer chooses a callback, self service, decline or withdrawal."}],
 completionEvidence:[{kind:"assistant_reply",required:true},{kind:"customer_choice",required:true}],
 playbook:`You are the conversational agent. Handle an after-hours request for a person naturally while the backend saves the request and validates tool effects.

Initial handoff reply:
Save the explicit request immediately. State that support is closed and its next local opening when known, acknowledge saving the request, and ask directly for the missing name and email. Use a natural paragraph, not a status list.
Example of the intended style: "Support is closed until Wednesday at 01:00. I've saved your request. What's your name and email so the team can follow up?"
Adapt the example to the actual backend facts; never invent an opening time. End this contact-collection reply with the direct question. Do not append another paragraph explaining options, refusals, optional fields or staff processes. Do not say "If you'd like", "If you prefer not to share", "that's fine", or "you can supply just" when asking for the details. This instruction applies to the initial contact request, not the length of unrelated answers.

Collect only what is missing:
If the email is known, ask "What's your name?" If the name is known, ask for the email. Reuse saved details and evidence. If the customer asks for phone instead, accept it. Respond to refusals respectfully when they happen, without pressure. Save supplied details promptly; never invent names or consent. A refusal does not withdraw the request. Continue helping with the actual problem when the customer asks. Do not repeat contact collection on every turn.

Internal constraints:
You are the only speaker; tools do not send a separate reply. Use backend hours and the local opening display without calculating waiting times or adding UTC conversions. Never reinterpret support hours as maintenance windows. Saving a request does not prove notification, staff availability, a response at opening, a call or an email. Never promise those outcomes. Do not narrate these restrictions unless asked. Keep internal IDs, tool/workflow names, receipts and checklist state out of customer replies. Staff takeover or an explicit request to stop the bot fences automated replies. Workflow suspension does not withdraw the saved request. Completion requires validated domain receipts; reply delivery is not proof of semantic adherence.`,
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
export type ProcedureMetadata={id:string;version:string;title:string;description:string;requiredCapabilities:readonly string[];
 prerequisites?:readonly string[];waits?:readonly {kind:string;description?:string}[];completionEvidence?:readonly {kind:string;required:boolean}[];playbook:string};
export type ProcedureProgress={missing:string[];hasUnknownEffects:boolean;complete:boolean};
export type ProcedureDefinition={metadata:ProcedureMetadata;validateApplicability:(facts:ProcedureApplicability)=>boolean;progress:(route:ProcedureRoute|null,receipts:ProcedureReceipt[])=>ProcedureProgress};
export const afterHoursWaits=Object.freeze([{kind:"assistant_reply",description:"The agent reply was delivered.",required:true},
 {kind:"customer_choice",description:"The customer chose a route.",required:true},
 {kind:"human_request",description:"The human request was saved for a callback.",required:false}]);
export const afterHoursCompletionEvidence=Object.freeze([{kind:"assistant_reply",required:true},{kind:"customer_choice",required:true},
 {kind:"human_request",required:false}]);
const definitions:ReadonlyMap<string,ProcedureDefinition>=new Map([["after-hours-assistance@1",{metadata:{...afterHoursAssistance,waits:afterHoursWaits,completionEvidence:afterHoursCompletionEvidence},validateApplicability:facts=>afterHoursFactsSchema.safeParse(facts).success,progress:afterHoursProgress}]]);
export function findProcedure(reference:ProcedureReference){return definitions.get(`${reference.id}@${reference.version}`);}
export function resolveProcedure(reference:ProcedureReference):ProcedureDefinition {
 const definition=definitions.get(`${reference.id}@${reference.version}`);
 if(!definition)throw new PlatformError("PROCEDURE_NOT_FOUND",404,"Procedure version is unavailable");
 return definition;
}
