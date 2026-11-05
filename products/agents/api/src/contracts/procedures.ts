import {z} from "zod";

export const procedureReferenceSchema = z.strictObject({id:z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),version:z.string().regex(/^[1-9][0-9]*$/)});
export type ProcedureReference = z.infer<typeof procedureReferenceSchema>;
export const procedureScopeSchema = z.strictObject({organizationId:z.uuid(),agentId:z.uuid(),conversationId:z.uuid()});
export type ProcedureScope = z.infer<typeof procedureScopeSchema>;
export const procedureRouteSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
export type ProcedureRoute = z.infer<typeof procedureRouteSchema>;
export const procedureReceiptSchema = z.strictObject({kind:z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/),sourceId:z.string().min(1).max(200),status:z.enum(["confirmed","unknown","failed"])});
export type ProcedureReceipt = z.infer<typeof procedureReceiptSchema>;
export const procedureUpdateSchema = z.strictObject({commandId:z.uuid(),expectedRevision:z.string().regex(/^[1-9][0-9]*$/),action:z.enum(["suspend","resume","cancel"]),reason:z.string().trim().min(1).max(500).optional()});
export type ProcedureUpdate = z.infer<typeof procedureUpdateSchema>;
export const procedureEvidenceSchema = z.strictObject({commandId:z.uuid(),expectedRevision:z.string().regex(/^[1-9][0-9]*$/),route:procedureRouteSchema.optional(),receipts:z.array(procedureReceiptSchema).max(32)});
export type ProcedureEvidence = z.infer<typeof procedureEvidenceSchema>;
export const procedureApplicabilitySchema = z.record(z.string().max(80),z.json()).refine(value=>JSON.stringify(value).length<=4096,"Procedure facts are too large");
export type ProcedureApplicability = z.infer<typeof procedureApplicabilitySchema>;
export type ProcedureStatus = "active"|"suspended"|"completed"|"cancelled";
export type ProcedureInstance = ProcedureScope & {id:string;definition:ProcedureReference;revision:string;status:ProcedureStatus;route:ProcedureRoute|null;applicability:ProcedureApplicability;receipts:ProcedureReceipt[];missing:string[];hasUnknownEffects:boolean;createdAt:string;updatedAt:string};
export const procedureInstanceSchema=z.strictObject({id:z.uuid(),organizationId:z.uuid(),agentId:z.uuid(),conversationId:z.uuid(),definition:procedureReferenceSchema,revision:z.string().regex(/^[1-9][0-9]*$/),status:z.enum(["active","suspended","completed","cancelled"]),route:procedureRouteSchema.nullable(),applicability:procedureApplicabilitySchema,receipts:z.array(procedureReceiptSchema).max(256),missing:z.array(z.string().max(80)).max(8),hasUnknownEffects:z.boolean(),createdAt:z.iso.datetime(),updatedAt:z.iso.datetime()});

export const procedureToolNames=['procedures.discover','procedures.load','procedures.start','procedures.inspect','procedures.update','procedures.cancel','support.request_assistance','support.update_assistance'] as const;
