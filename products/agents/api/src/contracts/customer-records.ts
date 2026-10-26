import {z} from "zod";
const text=(max:number)=>z.string().trim().max(max).refine(value=>!value.includes('\0'),"Invalid character");
export const recordFieldsSchema=z.strictObject({name:text(200).optional(),email:text(320).optional(),phone:text(80).optional(),service:text(500).optional(),message:text(4000).optional()}).refine(value=>Object.values(value).some(Boolean),"Enter customer details").refine(value=>Buffer.byteLength(JSON.stringify(value),"utf8")+2*Object.keys(value).length<=8192,"Customer details exceed the storage limit");
export const contactFieldsSchema=z.strictObject({name:text(200).nullable().optional(),email:text(320).nullable().optional(),phone:text(80).nullable().optional()});
export const recordStatusSchema=z.enum(["new","in_progress","waiting_on_customer","closed"]);
const identity={commandId:z.uuid(),expectedRevision:z.string().regex(/^[1-9]\d*$/)};
export const recordCommandSchema=z.discriminatedUnion("action",[
 z.strictObject({...identity,action:z.literal("claim")}),
 z.strictObject({...identity,action:z.literal("assign"),assigneeAccountId:z.uuid()}),
 z.strictObject({...identity,action:z.literal("unassign")}),
 z.strictObject({...identity,action:z.literal("set-status"),status:recordStatusSchema}),
 z.strictObject({...identity,action:z.literal("reopen")}),
 z.strictObject({...identity,action:z.literal("set-due"),dueAt:z.iso.datetime({offset:true}).nullable()}),
 z.strictObject({...identity,action:z.literal("note"),body:text(4000).min(1)}),
 z.strictObject({...identity,action:z.literal("correct"),fields:recordFieldsSchema}),
 z.strictObject({...identity,action:z.literal("link-contact"),contactId:z.uuid().nullable()})
]);
export type RecordCommand=z.infer<typeof recordCommandSchema>;
export const recordCreateSchema=z.strictObject({commandId:z.uuid(),fields:recordFieldsSchema,contactId:z.uuid().optional()});
export const contactCreateSchema=contactFieldsSchema.extend({commandId:z.uuid()}).refine(value=>Boolean(value.name||value.email||value.phone),"Enter contact details");
export const contactCommandSchema=contactFieldsSchema.extend({...identity,action:z.literal("correct")});
export const recordListSchema=z.object({status:recordStatusSchema.optional(),assigned:z.enum(["mine","unassigned"]).optional(),due:z.enum(["overdue","scheduled"]).optional(),agentId:z.uuid().optional(),conversationId:z.uuid().optional(),contactId:z.uuid().optional(),search:text(120).optional(),cursor:z.string().max(2048).optional(),limit:z.coerce.number().int().min(1).max(100).default(30)});
export const contactListSchema=z.object({search:text(120).optional(),cursor:z.string().max(2048).optional(),limit:z.coerce.number().int().min(1).max(100).default(30)});
export type RecordFields=z.infer<typeof recordFieldsSchema>;
export interface CustomerContact {id:string;revision:string;name:string|null;email:string|null;phone:string|null;createdAt:string;updatedAt:string}
export interface CustomerRecordActivity {id:string;kind:string;actorAccountId:string|null;body:string|null;createdAt:string}
export interface RecordEnquiry {id:string;revision:string;status:z.infer<typeof recordStatusSchema>;fields:RecordFields;originalFields:RecordFields;sourceEnquiryId:string|null;sourceTaskId:string|null;agentId:string|null;conversationId:string|null;customerConversationId:string|null;channel:string|null;contactId:string|null;assigneeAccountId:string|null;dueAt:string|null;createdAt:string;updatedAt:string;activity?:CustomerRecordActivity[];bookings?:{id:string;state:string;startsAt:string;endsAt:string}[]}
