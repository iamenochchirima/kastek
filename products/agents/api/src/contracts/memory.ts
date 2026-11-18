import type { InitiatingPrincipal } from "./contracts";
import type { SkillPackage } from "./skills";
import { MEMORY_ASSERTION_CONTEXTS, MEMORY_CONFLICT_STATES } from "@kasitek-labs/contracts";
import { z } from "zod";

export const memoryAssertionSchema = z.strictObject({
  context: z.enum(MEMORY_ASSERTION_CONTEXTS),
  conflict: z.enum(MEMORY_CONFLICT_STATES),
});
export type MemoryAssertion = z.infer<typeof memoryAssertionSchema>;

export interface MemoryScope { organizationId: string; agentId: string; principal: InitiatingPrincipal; taskId?: string }
export interface ManagementScope { accountId: string; organizationId: string; agentId: string }
export interface SkillRevision { id: string; name: string; description: string; body: string; revision: number; contentDigest: string; createdAt: string;
  familyId?:string; state?:"enabled"|"disabled"|"removed"; reviewState?: "pending" | "reviewed"; package?: SkillPackage; reviewedDigest?: string }
