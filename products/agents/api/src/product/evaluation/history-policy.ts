import type { PoolClient } from "pg";
import { z } from "zod";
import { deliveryTargetsFromEnvironment } from "../../adapters/providers/report-delivery";
import { REPORT_WORKFLOW_BINDING, toolDescriptor } from "../../capabilities/tool-descriptors";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { assertCurrentEvidence } from "../../execution/context/evidence-policy";
import { loadExecution } from "../../execution/lifecycle/state";

const unavailable = () => new PlatformError("EXPORT_DEPENDENCY_UNAVAILABLE", 403, "Execution dependency is unavailable");
export const withheldDependency = (error: unknown): boolean => error instanceof PlatformError && [403, 404, 409, 503].includes(error.statusCode);
export interface ExportRoot { id: string; organization_id: string; agent_id: string; principal: { kind: string; issuer: string; subject: string } }

/** Artifact metadata and transitive fences must still be readable before a URL or receipt is exposed. */
export async function assertExportArtifact(db: PoolClient, root: ExportRoot, artifactId: string): Promise<void> {
  const visited = new Set<string>(), active = new Set<string>();
  let edges = 0;
  async function visit(id: string, depth: number) {
    if (depth > 32 || ++edges > 128 || active.has(id)) throw unavailable();
    if (visited.has(id)) return; active.add(id);
    const artifact = (await db.query(`SELECT * FROM agents_platform.artifacts WHERE id=$1 AND organization_id=$2 AND root_task_id=$3 FOR SHARE`, [id, root.organization_id, root.id])).rows[0];
    if (!artifact || artifact.state !== "available" || !Array.isArray(artifact.source_references) || artifact.source_references.length > 128) throw unavailable();
    const evidence = (await db.query("SELECT manifest FROM agents_platform.evidence_nodes WHERE root_task_id=$1 AND task_id=$2 AND kind='artifact' AND owner_id=$3", [root.id, artifact.task_id, id])).rows[0];
    if (!evidence) throw unavailable();
    await assertCurrentEvidence(db, artifact.task_id, evidence.manifest, { requireActiveTask: false });
    for (const reference of artifact.source_references) {
      if (++edges > 128 || !reference || typeof reference !== "object") throw unavailable();
      if (reference.kind === "artifact") await visit(z.uuid().parse(reference.id), depth + 1);
      else if (reference.kind === "memory_scope") {
        const memory = (await db.query(`SELECT generation,next_expiry_at FROM agents_platform.memory_scopes WHERE id=$1 AND organization_id=$2 AND agent_id=$3
          AND account_id=(SELECT id FROM agents_platform.accounts WHERE issuer=$4 AND subject=$5) FOR SHARE`, [reference.id, root.organization_id, root.agent_id, root.principal.issuer, root.principal.subject])).rows[0];
        if (!memory || Number(memory.generation) !== Number(reference.generation) || memory.next_expiry_at && new Date(memory.next_expiry_at).getTime() <= Date.now() || reference.expiresAt !== undefined && Number(reference.expiresAt) <= Date.now()) throw unavailable();
      } else if (reference.kind === "evidence") {
        const node = (await db.query("SELECT manifest FROM agents_platform.evidence_nodes WHERE id=$1 AND task_id=$2 AND root_task_id=$3", [reference.id, artifact.task_id, root.id])).rows[0];
        if (!node || node.manifest.digest !== reference.digest) throw unavailable();
        await assertCurrentEvidence(db, artifact.task_id, node.manifest, { requireActiveTask: false });
      } else throw unavailable();
    }
    active.delete(id); visited.add(id);
  }
  await visit(artifactId, 0);
}
const receiptSchema = z.strictObject({ id: z.uuid(), payloadDigest: z.string().regex(/^[a-f0-9]{64}$/), acceptedAt: z.iso.datetime() });
export interface EffectExport { records: unknown[]; omissions: string[] }

/** Delivery state is copied from native receipts; approval never establishes external acceptance. */
export async function exportReportEffects(db: PoolClient, root: ExportRoot, visibleTasks: ReadonlySet<string>): Promise<EffectExport> {
  const actions = (await db.query("SELECT * FROM agents_platform.actions WHERE root_task_id=$1 AND organization_id=$2 ORDER BY created_at,id LIMIT 1025", [root.id, root.organization_id])).rows;
  if (actions.length > 1024) throw new PlatformError("EXPORT_LIMIT", 413, "Execution history exceeds the export limit");
  const result: EffectExport = { records: [], omissions: [] };
  for (const action of actions) {
    try {
      if (!visibleTasks.has(action.task_id) || action.state === "invalidated" || action.state === "expired") throw unavailable();
      const execution = await loadExecution(db, action.task_id);
      const workflow = execution.configuration.capabilities.workflows;
      if (!workflow.enabled || workflow.profileId !== "report-delivery-v1" || workflow.connectionId !== action.connection_id || action.task_id !== root.id) throw unavailable();
      const account = (await db.query("SELECT id FROM agents_platform.accounts WHERE issuer=$1 AND subject=$2", [root.principal.issuer, root.principal.subject])).rows[0];
      if (!account || account.id !== action.account_id) throw unavailable();
      const membership = await db.query("SELECT account_id FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=ANY($2::uuid[]) AND revoked_at IS NULL FOR SHARE", [root.organization_id, [...new Set([action.account_id, action.reviewer_account_id])]]);
      if (membership.rowCount !== new Set([action.account_id, action.reviewer_account_id]).size) throw unavailable();
      const connection = (await db.query("SELECT * FROM agents_platform.connections WHERE id=$1 AND organization_id=$2 AND account_id=$3 FOR SHARE", [action.connection_id, root.organization_id, account.id])).rows[0];
      const target = deliveryTargetsFromEnvironment().find(target => target.id === action.target_id);
      if (!connection || connection.state !== "active" || connection.profile_id !== "report-delivery-v1" || new Date(connection.expires_at).getTime() <= Date.now() || connection.revision !== action.connection_revision || !target || requestDigest(target) !== action.target_digest || target.resource !== connection.resource || target.id !== connection.target_id) throw unavailable();
      const node = (await db.query("SELECT manifest FROM agents_platform.evidence_nodes WHERE id=$1 AND task_id=$2 AND root_task_id=$3 AND kind='artifact' AND owner_id=$4", [action.evidence_node_id, action.task_id, root.id, `review:${action.id}`])).rows[0];
      if (!node) throw unavailable();
      await assertCurrentEvidence(db, action.task_id, node.manifest, { requireActiveTask: false });
      await assertExportArtifact(db, root, action.artifact_id);
      const artifact = (await db.query("SELECT content_digest FROM agents_platform.artifacts WHERE id=$1", [action.artifact_id])).rows[0];
      if (artifact?.content_digest !== action.artifact_digest || requestDigest(action.payload) !== action.payload_digest) throw unavailable();
      const bindingDigest = requestDigest({ versionId: execution.task.version_id, configuration: execution.configuration, toolBindings: execution.toolBindings,
        workflow: REPORT_WORKFLOW_BINDING, descriptor: toolDescriptor("report.deliver"), reviewer: action.reviewer_account_id });
      const reviewDigest = requestDigest({ evidenceManifestDigest: node.manifest.digest, id: action.id, taskId: action.task_id, rootTaskId: root.id, principal: execution.task.principal,
        connectionId: action.connection_id, connectionRevision: action.connection_revision, target, payloadDigest: action.payload_digest, artifactId: action.artifact_id,
        expiresAt: new Date(action.expires_at).toISOString(), bindingDigest, reviewer: action.reviewer_account_id });
      if (bindingDigest !== action.binding_digest || reviewDigest !== action.review_digest) throw unavailable();
      const approved = ["approved", "claimed", "delivered", "uncertain", "failed"].includes(action.state);
      if (approved && (!action.approved_at || new Date(action.approved_at) >= new Date(action.expires_at)) || ["pending_review", "approved"].includes(action.state) && new Date(action.expires_at).getTime() <= Date.now()) throw unavailable();
      const parsedReceipt = action.receipt === null ? null : receiptSchema.safeParse(action.receipt);
      if (parsedReceipt && (!parsedReceipt.success || parsedReceipt.data.id !== action.id || parsedReceipt.data.payloadDigest !== action.payload_digest) || action.state === "delivered" && (!parsedReceipt || !parsedReceipt.success || !action.claimed_at)) throw unavailable();
      const decisions = (await db.query("SELECT operation_id,request_digest,result FROM agents_platform.action_decisions WHERE action_id=$1 ORDER BY operation_id LIMIT 129", [action.id])).rows;
      if (decisions.length > 128) throw new PlatformError("EXPORT_LIMIT", 413, "Execution history exceeds the export limit");
      if (approved && !decisions.some(decision => decision.result?.id === action.id && decision.result?.state === "approved")) throw unavailable();
      result.records.push({ schemaVersion: "report-delivery-receipt.v1", actionId: action.id, taskId: action.task_id, rootTaskId: root.id, operationId: action.operation_id,
        artifactId: action.artifact_id, artifactDigest: action.artifact_digest, payloadDigest: action.payload_digest, reviewDigest: action.review_digest, state: action.state,
        approvedAt: action.approved_at?.toISOString() ?? null, claimedAt: action.claimed_at?.toISOString() ?? null, expiresAt: action.expires_at.toISOString(),
        receipt: parsedReceipt?.success ? parsedReceipt.data : null, errorCode: action.error_code,
        reviewRecords: decisions.map(decision => ({ operationId: decision.operation_id, requestDigest: decision.request_digest, state: typeof decision.result?.state === "string" ? decision.result.state : null })) });
    } catch (error) {
      if (!withheldDependency(error)) throw error;
      result.omissions.push("Report delivery record withheld because its source, approval or current connection policy is unavailable");
    }
  }
  return result;
}
