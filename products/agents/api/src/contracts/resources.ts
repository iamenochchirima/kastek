import { z } from "zod";
export const resourceHandleSchema = z.strictObject({ kind: z.string().min(1).max(64), id: z.string().min(1).max(4096) });
export type ResourceHandle = z.infer<typeof resourceHandleSchema>;
