import { z } from "zod";
import type { ProcedureDefinition, ProcedureMetadata } from "./procedure-definitions";

const workflowIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const evidenceKindSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);

/** A declarative workflow revision published by a workspace owner. */
export const workflowRevisionInputSchema = z.strictObject({
  id: workflowIdSchema,
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(4000),
  playbook: z.string().trim().min(1).max(10000).optional(),
  prerequisites: z.array(z.string().trim().min(1).max(120)).max(20).default([]),
  waits: z.array(z.strictObject({
    kind: evidenceKindSchema,
    description: z.string().trim().min(1).max(500).optional(),
  })).max(20).default([]),
  completionEvidence: z.array(z.strictObject({
    kind: evidenceKindSchema,
    required: z.boolean(),
  })).min(1).max(20),
});
export type WorkflowRevisionInput = z.infer<typeof workflowRevisionInputSchema>;

export type WorkflowRevision = WorkflowRevisionInput & { version: string; digest: string; publishedAt: string };

/**
 * Converts a stored revision into the same definition shape as the built-in procedures, so
 * prerequisites, declared waits and completion evidence drive the runtime without a code edit.
 */
export function declarativeProcedureDefinition(revision: WorkflowRevisionInput & { version: string; digest: string }): ProcedureDefinition {
  const metadata: ProcedureMetadata = {
    id: revision.id,
    version: revision.version,
    title: revision.title,
    description: revision.description,
    requiredCapabilities: revision.prerequisites,
    prerequisites: revision.prerequisites,
    waits: revision.waits,
    completionEvidence: revision.completionEvidence,
    playbook: revision.playbook ?? revision.description,
  };
  return {
    metadata,
    validateApplicability: () => true,
    progress: (_route, receipts) => {
      const required = [...new Set([...revision.waits.map(wait => wait.kind),
        ...revision.completionEvidence.filter(entry => entry.required).map(entry => entry.kind)])];
      const missing = required.filter(kind => !receipts.some(receipt => receipt.kind === kind && receipt.status === "confirmed"));
      const hasUnknownEffects = receipts.some(receipt => receipt.status === "unknown");
      return { missing, hasUnknownEffects, complete: missing.length === 0 && !hasUnknownEffects };
    },
  };
}
