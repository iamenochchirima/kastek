import { z } from "zod";

const unique = <T>(values: T[]) => new Set(values).size === values.length;
export const customerSetupSchema = z.object({
  business: z.object({
    name: z.string().trim().min(1).max(120),
    website: z.string().trim().max(2048).default(""),
    description: z.string().trim().max(1500).default(""),
  }).strict(),
  responsibilities: z.array(z.enum(["answer-questions", "customer-support", "bookings", "enquiries"])).min(1).max(4).refine(unique, "Choose each responsibility once"),
  channels: z.array(z.enum(["website", "whatsapp", "facebook", "instagram", "telegram"])).max(5).refine(unique, "Choose each channel once"),
  booking: z.object({ durationMinutes: z.number().int().min(5).max(240), notes: z.string().trim().max(1000) }).strict().optional(),
  intake: z.object({ fields: z.array(z.enum(["name", "email", "phone", "service", "message"])).min(1).max(5).refine(unique, "Choose each field once") }).strict().optional(),
  behaviour: z.object({
    agentName: z.string().trim().min(1).max(120),
    language: z.string().trim().min(1).max(80),
    tone: z.enum(["friendly", "professional", "concise"]),
    handoffInstructions: z.string().trim().max(1000),
  }).strict(),
}).strict().refine(value => JSON.stringify(value).length <= 6000, "Keep business details and operating preferences under 6,000 characters");
export type CustomerSetup = z.infer<typeof customerSetupSchema>;

