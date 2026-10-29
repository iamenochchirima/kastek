import type { PoolClient } from "pg";
import { supportStatusV2 } from "../../capabilities/support-status-v2";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { assertCurrentEvidence, taskEvidenceManifest } from "../../execution/context/evidence-policy";
import { supportStatusRequestForEpisode } from "../../execution/business/support-status-request";
import { inspectInboxOutput, loadExecution } from "../../execution/lifecycle/state";
import type { StatusNoticeBinding } from "./support-status-notice";

export async function verifySupportStatusFacts(db: PoolClient, binding: StatusNoticeBinding, _body: string): Promise<boolean> {
  return verify(db,binding,false);
}

// Past replies retain their original support facts, while their evidence remains revocable.
export async function verifyHistoricalSupportStatusEvidence(db: PoolClient, binding: StatusNoticeBinding, _body: string): Promise<boolean> {
  return inspectInboxOutput(()=>verify(db,binding,true));
}

async function verify(db: PoolClient, binding: StatusNoticeBinding, historical: boolean): Promise<boolean> {
  try {
    const execution=await loadExecution(db,binding.taskId);
    if (execution.task.organization_id!==binding.organizationId) return false;
    const row=(await db.query(`SELECT op.request,op.request_digest,m.body FROM agents_platform.operations op
      JOIN agents_platform.customer_messages m ON m.id=$2 AND m.conversation_id=$3 AND m.author_kind='visitor'
      WHERE op.id=$1 AND op.task_id=$4 AND op.state='completed' FOR SHARE OF op,m`,
      [`support-status:${binding.taskId}`,binding.inputMessageId,binding.conversationId,binding.taskId])).rows[0];
    if (!row || !row.request?.supportFacts || !row.request?.modelRequest || execution.task.input!==row.body || requestDigest(row.request)!==row.request_digest) return false;
    const facts=historical ? row.request.supportFacts : await supportStatusV2(db,binding.organizationId,execution.configuration.supportHours);
    if (requestDigest(row.request?.supportFacts)!==requestDigest(facts)
      || requestDigest(row.request?.modelRequest)!==requestDigest(await supportStatusRequestForEpisode(db,execution,facts))) return false;
    await assertCurrentEvidence(db,binding.taskId,await taskEvidenceManifest(db,binding.taskId),{requireActiveTask:false});
    return true;
  } catch (error) {
    if(error instanceof PlatformError) return false;
    throw error;
  }
}
