import type { PoolClient } from "pg";
import type { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import type { Execution } from "../../contracts/execution";
import { orchestrationContracts, specialistResultMetadataSchema } from "../../contracts/orchestration";
import type { EvidenceDependency } from "../../contracts/source-contracts";
import { assertCurrentEvidence, suppliedNodes, taskEvidenceManifest } from "../context/evidence";
import { TaskArtifactStore } from "../artifacts/task-artifacts";
import { readWorkProgress } from "./progress";

type ResultInput = z.infer<typeof orchestrationContracts["agents.result"]["input"]>;
const pageSize = 8;
function page<T>(rows: T[], offset: number) {
  return { items: rows.slice(0, pageSize), nextOffset: rows.length > pageSize ? offset + pageSize : null };
}

/** Accepted native records supplement the child report; they do not grade its prose or grant access. */
export async function specialistResultMetadata(db: PoolClient, parent: Execution, child: Execution, input: ResultInput, artifactStore: TaskArtifactStore) {
  const sourceOffset = input.sourceOffset ?? 0, effectOffset = input.effectOffset ?? 0, artifactOffset = input.artifactOffset ?? 0;
  for (const offset of [sourceOffset, effectOffset, artifactOffset]) {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new PlatformError("TOOL_ARGUMENTS_INVALID", 400, "Check result pagination");
  }
  await assertCurrentEvidence(db, child.task.id, await taskEvidenceManifest(db, child.task.id), { requireActiveTask: false });
  const nodes = await suppliedNodes(db, child);
  const evidenceIds = [...new Set(nodes.flatMap(node => node.evidenceIds))];
  const selectedTaskIds = [...new Set([child.task.id, ...nodes.filter(node => node.kind === "child_result").map(node => node.taskId)])];
  const sources = evidenceIds.length ? (await db.query(`SELECT e.id,e.task_id,e.operation_id,e.citation_label,e.content_digest,
      e.source_id,e.manifest,c.binding_id FROM agents_platform.evidence_references e
      JOIN agents_platform.evidence_contents c ON c.reference_id=e.id
      WHERE e.organization_id=$1 AND e.id=ANY($2::uuid[]) ORDER BY e.citation_label LIMIT 9 OFFSET $3`,
  [parent.task.organization_id, evidenceIds, sourceOffset])).rows.map(row => ({
    evidenceId: row.id, citation: `[${row.citation_label}]`, taskId: row.task_id, operationId: row.operation_id,
    contentDigest: row.content_digest, kind: row.binding_id ? "connection" : row.source_id ? "source" :
      row.manifest.dependencies.some((dependency: EvidenceDependency) => dependency.kind === "product") ? "product" : "memory",
  })) : [];

  // Review state and delivery receipts are native observations. No arguments, payloads or private notes cross this boundary.
  const effects = (await db.query(`SELECT * FROM (
      SELECT 'product_review' AS kind,review_id AS id,task_id,projection->>'operationId' AS operation_id,state,product
        FROM agents_platform.product_review_projections WHERE task_id=ANY($1::uuid[])
      UNION ALL SELECT 'connected_review',id::text,task_id,operation_id,state,NULL::text
        FROM agents_platform.tool_invocation_reviews WHERE task_id=ANY($1::uuid[])
      UNION ALL SELECT 'report_action',id::text,task_id,operation_id,state,NULL::text
        FROM agents_platform.actions WHERE task_id=ANY($1::uuid[])
    ) records ORDER BY kind,id,coalesce(product,'') LIMIT 9 OFFSET $2`, [selectedTaskIds, effectOffset])).rows.map(row => ({
    kind: row.kind, id: row.id, taskId: row.task_id, operationId: row.operation_id, state: row.state, product: row.product,
    confirmation: row.state === "uncertain" || row.state === "claimed" || row.state === "executing" ? "unknown" :
      row.kind === "product_review" && row.state === "saved" || row.kind === "connected_review" && row.state === "completed" ||
      row.kind === "report_action" && row.state === "delivered" ? "confirmed" : "not_confirmed",
  }));

  const grant = (await db.query("SELECT operations FROM agents_platform.execution_grants WHERE id=$1", [parent.task.grant_id])).rows[0];
  let artifacts: Record<string, unknown>[] = [];
  if (grant?.operations.includes("artifact.read") &&
      ["human", "automation"].includes(parent.task.principal.kind)) {
    artifacts = (await db.query(`SELECT a.id,a.task_id,a.name,a.content_type,a.bytes,a.content_digest
      FROM agents_platform.artifacts a WHERE a.organization_id=$1 AND a.root_task_id=$2 AND a.task_id=ANY($3::uuid[])
        AND a.state='available' AND (a.task_id=$4 OR $4=$2 OR EXISTS(
          SELECT 1 FROM agents_platform.task_artifact_transfers x WHERE x.artifact_id=a.id AND x.target_task_id=$4))
      ORDER BY a.created_at,a.id LIMIT 9 OFFSET $5`,
    [parent.task.organization_id, parent.task.root_task_id, selectedTaskIds, parent.task.id, artifactOffset])).rows;
    for (const artifact of artifacts.slice(0, pageSize)) await artifactStore.inspectForTask(parent.task.id, artifact.id as string);
  }
  return specialistResultMetadataSchema.parse({
    version: "1", findings: { origin: "agent_reported", format: "text", correctness: "not_assessed" },
    coverage: { assessment: "not_assessed", work: { ...await readWorkProgress(db, child.task.id), origin: "agent_reported" } },
    sources: page(sources, sourceOffset), effects: page(effects, effectOffset),
    artifacts: page(artifacts.map(row => ({ id: row.id, taskId: row.task_id, name: row.name,
      contentType: row.content_type, bytes: row.bytes, contentDigest: row.content_digest })), artifactOffset),
  });
}
