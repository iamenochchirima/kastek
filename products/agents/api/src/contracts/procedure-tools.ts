import {z} from 'zod';
import type {AgentConfiguration} from './contracts';
import type {ToolDefinition} from './model-messages';
import {procedureToolNames,procedureInstanceSchema,procedureReferenceSchema,type ProcedureReference} from './procedures';
import {requestHumanAssistanceInputSchema} from './human-assistance';
import {afterHoursAssistance} from './procedure-definitions';
export {procedureToolNames} from './procedures';

type Name=typeof procedureToolNames[number];
const reference=procedureReferenceSchema;
const metadata=z.strictObject({id:z.string().max(80),version:z.string().max(20),title:z.string().max(120),description:z.string().max(500),requiredCapabilities:z.array(z.string().max(100)).max(16)});
const revision=z.string().regex(/^[1-9][0-9]*$/);
const hours=z.union([z.strictObject({state:z.literal('unknown')}),z.strictObject({state:z.enum(['open','closed']),timeZone:z.string().max(128),intervals:z.array(z.strictObject({day:z.number().int().min(0).max(6),start:z.string().max(5),end:z.string().max(5)})).max(28)})]);
const assistanceResult=z.strictObject({requestId:z.uuid(),status:z.enum(['requested','human_owned','completed','withdrawn']),state:z.enum(['automation_active','handoff_pending','human_owned','resolved']),noticeMessageId:z.uuid(),supportFacts:z.strictObject({hours,nextOpening:z.iso.datetime().nullable(),staffAvailability:z.enum(['available','away','unknown']),responseTime:z.literal('unknown')})});
const authority=['channel.handoff'];
const resources=['selected_procedure_version','current_channel_generation','trusted_conversation','product_receipts'];
const read={authority,resources,reconciliation:'not_applicable'};
const write={authority,resources,reconciliation:'idempotent_receipt'};
export const publicUpdateAssistanceSchema=z.strictObject({
 requestId:z.uuid().describe("The existing human support request ID returned by support.request_assistance."),
 action:z.enum(['save_contact','human_only','withdrawn','self_service','declined']).describe("Choose exactly one action. save_contact saves a follow-up preference while the agent keeps helping. human_only means the customer explicitly says to STOP the bot or automated replies; merely asking for a human is NOT human_only. withdrawn cancels the human request; self_service means the customer chooses agent help instead; declined means they decline follow-up."),
 evidenceMessageId:z.uuid().describe("The customer message ID containing their consent or explicit choice, from customerEvidence. Supply this once at the top level."),
 evidenceQuote:z.string().trim().min(1).max(1000).describe("An exact quote from evidenceMessageId showing the customer's consent to the saved contact preference, or their explicit selected action. Never invent or paraphrase it."),
 contact:z.strictObject({
  method:z.enum(['same_channel','email','phone']).describe("The customer's preferred follow-up method. same_channel uses this conversation and requires no value."),
  value:z.string().trim().min(1).max(320).optional().describe("Exact email address or phone number the customer supplied; required for email/phone, omitted for same_channel."),
  name:z.string().trim().min(1).max(200).optional().describe("The customer's name, only if supplied by them."),
  preferredTime:z.string().trim().min(1).max(200).optional().describe("Their exact preferred contact time, only if supplied; this is a preference, not a confirmed appointment."),
  fieldEvidence:z.strictObject({
   value:z.uuid().optional().describe("Customer message ID containing value, if it appears in a different message from the consent quote."),
   name:z.uuid().optional().describe("Customer message ID containing name, if different from the consent message."),
   preferredTime:z.uuid().optional().describe("Customer message ID containing preferredTime, if different from the consent message."),
  }).optional().describe("Source message IDs for fields supplied in earlier messages. All values must be exact customer-provided text."),
 }).optional().describe("Include only for action save_contact. Do not put evidenceMessageId or consentQuote inside contact; evidence is supplied at the top level."),
}).superRefine((value,context)=>{
 if(value.action==='save_contact'&&!value.contact)context.addIssue({code:'custom',path:['contact'],message:'Contact is required for save_contact'});
 if(value.action!=='save_contact'&&value.contact)context.addIssue({code:'custom',path:['contact'],message:'Contact is only allowed with save_contact'});
});
export const procedureToolContracts={
 'procedures.discover':{input:z.strictObject({}),output:z.strictObject({procedures:z.array(metadata).max(32)}),...read},
 'procedures.load':{input:reference,output:metadata.extend({playbook:z.string().max(10000)}),...read},
 'procedures.start':{input:reference,output:procedureInstanceSchema.extend({procedure:metadata.extend({playbook:z.string().max(10000)})}),...write},
 'procedures.inspect':{input:z.strictObject({instanceId:z.uuid().optional()}),output:z.strictObject({instances:z.array(procedureInstanceSchema).max(100)}),...read},
 'procedures.update':{input:z.strictObject({instanceId:z.uuid(),expectedRevision:revision,action:z.enum(['suspend','resume']),reason:z.string().trim().min(1).max(500).optional()}),output:procedureInstanceSchema,...write},
 'procedures.cancel':{input:z.strictObject({instanceId:z.uuid(),expectedRevision:revision,reason:z.string().trim().min(1).max(500).optional()}),output:procedureInstanceSchema,...write},
 'support.request_assistance':{input:requestHumanAssistanceInputSchema,output:assistanceResult,...write},
 'support.update_assistance':{input:publicUpdateAssistanceSchema,output:assistanceResult,...write},
} as const;
const descriptions:Record<Name,string>={
 'procedures.discover':'Discover the selected, authorized business procedures.',
 'procedures.load':'Read the exact procedure playbook before using it. This grants no new permissions.',
 'procedures.start':'Start or restore a selected procedure using current backend applicability facts.',
 'procedures.inspect':'Inspect durable procedure progress and outstanding requirements.',
 'procedures.update':'Suspend or resume a procedure. This does not withdraw a recorded support request.',
 'procedures.cancel':'Cancel procedure execution. Existing human requests and external effects remain; use the support tool to withdraw a request.',
 'support.request_assistance':'Record a request for human support with current hours feedback, while keeping the assistant available. Does not transfer ownership to staff.',
 'support.update_assistance':'Choose one explicit action with customer-message evidence. Use save_contact to save a preference and continue helping. Use human_only ONLY when the customer explicitly wants automated replies to stop, never just because they request a human. Never combine saving contact and pausing the agent.',
};
export const selectedProcedures=(config:AgentConfiguration)=>config.procedures??[];
function handoffConfigured(config:AgentConfiguration){return config.tools.some(name=>['channel.request_handoff','support.request_handoff','support.request_handoff_v2','support.request_assistance'].includes(name));}
export function procedureReady(config:AgentConfiguration,ref:ProcedureReference){return handoffConfigured(config)&&!!config.supportHours&&config.tools.includes('support.get_status_v2')&&ref.id===afterHoursAssistance.id&&ref.version===afterHoursAssistance.version;}
export function procedureModelTools(config:AgentConfiguration):ToolDefinition[]{
 if(!selectedProcedures(config).some(ref=>procedureReady(config,ref)))return [];
 return procedureToolNames.map(name=>({type:'function',function:{name:name.replaceAll('.','_'),description:descriptions[name],parameters:z.toJSONSchema(procedureToolContracts[name].input) as Record<string,unknown>}}));
}
