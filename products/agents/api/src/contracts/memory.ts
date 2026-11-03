import { MEMORY_ASSERTION_CONTEXTS, MEMORY_CONFLICT_STATES } from "@kasitek-labs/contracts";
import { z } from "zod";

export const memoryAssertionSchema = z.strictObject({
  context: z.enum(MEMORY_ASSERTION_CONTEXTS),
  conflict: z.enum(MEMORY_CONFLICT_STATES),
});
export type MemoryAssertion = z.infer<typeof memoryAssertionSchema>;
