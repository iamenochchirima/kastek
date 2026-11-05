import {z} from "zod";
import {handoffBriefSchema} from "./channel";

import {preferredSupportContactSchema} from "./support-contact";
export {preferredSupportContactSchema,type PreferredSupportContact} from "./support-contact";
export const requestHumanAssistanceInputSchema=z.strictObject({brief:handoffBriefSchema});
export const requestHumanAssistanceSchema=requestHumanAssistanceInputSchema.extend({operationId:z.string().min(1).max(256)});
export const updateHumanAssistanceInputSchema=z.strictObject({requestId:z.uuid(),contact:preferredSupportContactSchema.optional(),disposition:z.enum(["human_only","withdrawn","self_service","declined"]).optional(),evidenceMessageId:z.uuid().optional(),evidenceQuote:z.string().trim().min(1).max(1000).optional()});
export const updateHumanAssistanceSchema=updateHumanAssistanceInputSchema.extend({operationId:z.string().min(1).max(256)}).refine(v=>!!v.contact||!!v.disposition,{message:"Choose a contact or disposition"});

