import { z } from "zod";
export const modelGenerationSchema = z.strictObject({
  temperature: z.number().finite().optional(),
  reasoning: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("effort"), value: z.string().regex(/^[a-z]+$/).max(32) }),
    z.strictObject({ kind: z.literal("budget"), tokens: z.number().int().nonnegative().max(2147483647) }),
    z.strictObject({ kind: z.literal("level"), value: z.string().regex(/^[a-z]+$/).max(32) }),
  ]).optional(),
});
export type ModelGenerationSettings = z.infer<typeof modelGenerationSchema>;
