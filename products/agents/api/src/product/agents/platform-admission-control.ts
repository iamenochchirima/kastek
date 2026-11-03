import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import { transaction } from "../../infrastructure/database";

export const platformAdmissionControlSchema = z.strictObject({
  action: z.enum(["drain", "resume"]),
  actor: z.string().trim().min(1).max(128),
  reason: z.string().trim().min(1).max(256),
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type PlatformAdmissionControlInput = z.infer<typeof platformAdmissionControlSchema>;

export interface PlatformAdmissionControlResult {
  action: PlatformAdmissionControlInput["action"];
  acceptingRoots: boolean;
  changed: boolean;
  revision: number;
  eventId: string | null;
}

/** Operator database authority only; this control is intentionally absent from product HTTP routes. */
export async function controlPlatformAdmissions(pool: Pool, raw: unknown): Promise<PlatformAdmissionControlResult> {
  const input = platformAdmissionControlSchema.parse(raw);
  return transaction(pool, async db => {
    const current = (await db.query<{ accepting_roots: boolean; revision: string }>(
      "SELECT accepting_roots,revision FROM agents_platform.platform_admission_gate WHERE id=1 FOR UPDATE",
    )).rows[0];
    if (!current) throw new PlatformError("ADMISSION_CONTROL_UNAVAILABLE", 503, "Task admission control is unavailable");
    const currentRevision = Number(current.revision);
    if (!Number.isSafeInteger(currentRevision) || currentRevision < 0 || currentRevision !== input.expectedRevision) {
      throw new PlatformError("ADMISSION_CONTROL_REVISION_CONFLICT", 409, "Task admission control changed; inspect the current gate revision");
    }
    const acceptingRoots = input.action === "resume";
    const changed = current.accepting_roots !== acceptingRoots;
    const revision = currentRevision + 1;
    if (!Number.isSafeInteger(revision)) throw new PlatformError("ADMISSION_CONTROL_UNAVAILABLE", 503, "Task admission revision is exhausted");
    const eventId = randomUUID();
    await db.query(`UPDATE agents_platform.platform_admission_gate
      SET accepting_roots=$1,revision=$2,changed_at=now(),changed_by=$3,reason=$4 WHERE id=1`,
    [acceptingRoots, revision, input.actor, input.reason]);
    await db.query(`INSERT INTO agents_platform.platform_admission_gate_events(id,revision,action,accepting_roots,actor,reason)
      VALUES($1,$2,$3,$4,$5,$6)`, [eventId, revision, input.action, acceptingRoots, input.actor, input.reason]);
    return { action: input.action, acceptingRoots, changed, revision, eventId };
  });
}
