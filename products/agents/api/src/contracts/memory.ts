import type { InitiatingPrincipal } from "./contracts";
import type { SkillPackage, SkillPackageCodec } from "./skills";
import type { Pool, PoolClient } from "pg";
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

/** Access check and skill loading surfaces execution needs without importing the memory store. */
export interface MemoryAccessPort {
  requireMemoryAccess(db: PoolClient, scope: ManagementScope): Promise<void>;
}
export interface SkillRevisionReader {
  loadSkillRevisions(db: Pool | PoolClient, organizationId: string, agentId: string, skillIds: string[], codec: SkillPackageCodec): Promise<SkillRevision[]>;
}

export interface MemoryRecord {
  id: string; kind: "semantic" | "episodic"; content: string;
  status: "candidate" | "accepted" | "forgotten"; revision: number; sourceTaskId: string | null;
  expiresAt: string | null; createdAt: string; updatedAt: string;
  origin: "user_supplied" | "model_candidate"; assertion: MemoryAssertion; verified: false;
}
/** The memory tool surface, so the tool gateway does not construct the store. */
export interface MemoryStorePort {
  read(scope: MemoryScope, query?: string, page?: { offset?: number; limit?: number }):
    Promise<{ generation: number; memories: MemoryRecord[]; nextOffset?: number }>;
  readOne(scope: MemoryScope, memoryId: string): Promise<{ generation: number; memory: MemoryRecord }>;
  propose(scope: MemoryScope, input: { operationId: string; kind: "semantic" | "episodic"; content: string;
    sourceTaskId?: string; expiresAt?: string; assertion?: MemoryAssertion }): Promise<{ id: string }>;
}
