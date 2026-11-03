import type { Pool, PoolClient } from "pg";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import type { Execution } from "../../contracts/execution";
import type { DependencyManifest } from "../../contracts/source-contracts";
import { assertCurrentEvidence, taskEvidenceManifest } from "./evidence-policy";
import { assertProductInformationForModel } from "../products/product-information";
import { instructionHead } from "./instruction-state";
export { instructionHead } from "./instruction-state";

type Db = Pool | PoolClient;
export interface PreparedContextManifest {
  version: 1; taskId: string; role: "primary" | "compaction" | "delegated";
  snapshotDigest: string | null; sourceReferences: unknown[]; historyGroupIds: string[];
  instructionHead: string; configurationDigest: string; routeDigest: string; policyDigest: string;
  evidence: DependencyManifest; countMethod: string; estimatedTokens: number | null;
  memoryFence: {scopeId:string;generation:number;expiresAt:number|null} | null;
}

export async function prepareRequestManifest(db: PoolClient, execution: Execution, input: {
  operationId: string; role: PreparedContextManifest["role"]; snapshotId?: string;
}): Promise<PreparedContextManifest> {
  const snapshot = input.snapshotId ? (await db.query("SELECT digest,payload,source_references,memory_scope_id,memory_generation FROM agents_platform.context_snapshots WHERE id=$1 AND task_id=$2", [input.snapshotId, execution.task.id])).rows[0] : undefined;
  if (input.snapshotId && !snapshot) throw new PlatformError("CONTEXT_SNAPSHOT_UNAVAILABLE", 409, "The prepared context is unavailable");
  const route = execution.models[input.role];
  const manifest: PreparedContextManifest = {
    version: 1, taskId: execution.task.id, role: input.role, snapshotDigest: snapshot?.digest ?? null,
    sourceReferences: snapshot?.source_references ?? [], historyGroupIds: snapshot?.payload.historyGroupIds ?? [],
    instructionHead: snapshot?.payload.instructionHead ?? await instructionHead(db, execution.task.id),
    configurationDigest: requestDigest(execution.configuration), routeDigest: requestDigest(route.binding), policyDigest: route.policy.digest,
    evidence: await taskEvidenceManifest(db, execution.task.id),
    countMethod: snapshot?.payload.countMethod ?? "serialized_bytes_estimate_with_native_prepared_count",
    estimatedTokens: snapshot?.payload.estimatedTokens ?? null,
    memoryFence: snapshot?.memory_scope_id ? {scopeId:snapshot.memory_scope_id,generation:Number(snapshot.memory_generation),expiresAt:snapshot.payload.memoryExpiresAt??null} : null,
  };
  await assertPreparedContext(db, execution, manifest, true);
  const digest = requestDigest(manifest);
  await db.query(`INSERT INTO agents_platform.model_request_manifests(operation_id,task_id,snapshot_id,digest,manifest)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(operation_id) DO NOTHING`, [input.operationId, execution.task.id, input.snapshotId ?? null, digest, manifest]);
  const stored = (await db.query("SELECT digest FROM agents_platform.model_request_manifests WHERE operation_id=$1 AND task_id=$2", [input.operationId, execution.task.id])).rows[0];
  if (!stored || stored.digest !== digest) throw new PlatformError("MODEL_MANIFEST_CONFLICT", 409, "The prepared request changed");
  return manifest;
}

export async function assertPreparedContext(db: Db, execution: Execution, manifest: PreparedContextManifest, checkInstructionHead: boolean): Promise<void> {
  if (manifest.taskId !== execution.task.id || manifest.configurationDigest !== requestDigest(execution.configuration) ||
    manifest.routeDigest !== requestDigest(execution.models[manifest.role].binding) || manifest.policyDigest !== execution.models[manifest.role].policy.digest) throw new PlatformError("CONTEXT_INVALIDATED", 409, "The context configuration changed");
  if (checkInstructionHead && manifest.instructionHead !== await instructionHead(db, execution.task.id)) throw new PlatformError("CONTEXT_PREPARATION_STALE", 409, "A newer instruction needs context preparation");
  if(manifest.memoryFence){
    const memory=(await db.query("SELECT generation,next_expiry_at FROM agents_platform.memory_scopes WHERE id=$1",[manifest.memoryFence.scopeId])).rows[0];
    if(!memory || Number(memory.generation)!==manifest.memoryFence.generation ||
      manifest.memoryFence.expiresAt!==null&&manifest.memoryFence.expiresAt<=Date.now() ||
      memory.next_expiry_at&&new Date(memory.next_expiry_at).getTime()<=Date.now())throw new PlatformError("CONTEXT_INVALIDATED",409,"The selected memory changed");
  }
  await assertCurrentEvidence(db, execution.task.id, manifest.evidence);
  await assertProductInformationForModel(db, execution.task.id, manifest.evidence, manifest.role);
}
