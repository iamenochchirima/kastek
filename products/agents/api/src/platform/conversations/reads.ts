import { canonicalJson, PlatformError, type AdmissionAuthority } from "../../contracts/contracts";
import type { TaskRecord } from "../../contracts/records";
import { AuthorityStore } from "../../execution/admission/authority-store";
import { resolveAutomationOwner } from "../../execution/lifecycle/automation-authority";
import { finishPage, readPageCursor, type PageQuery } from "../../infrastructure/read-pages";

/**
 * Conversation and turn reads. Ownership of chat turns lives here; admission owns creating them.
 * Authority checks use the same principal and version rules as admission.
 */
export class ConversationReads extends AuthorityStore {
  async getConversation(authority: AdmissionAuthority, conversationId: string): Promise<TaskRecord[]> {
    return (await this.getConversationPage(authority, conversationId, { limit: 100 })).items;
  }

  async getConversationPage(authority: AdmissionAuthority, conversationId: string, query: PageQuery) {
    const scope = { kind: "turns", authority, conversationId }, cursor = readPageCursor(query.cursor, scope);
    return this.transaction(async db => {
      const conversation = (await db.query<{ agent_id: string; principal: unknown; deployment_id: string | null; deleted_at: Date | null }>(
        "SELECT agent_id,principal,deployment_id,deleted_at FROM agents_platform.conversations WHERE organization_id=$1 AND id=$2 FOR SHARE",
        [authority.organizationId, conversationId])).rows[0] ?? absent();
      if (canonicalJson(conversation.principal) !== canonicalJson(authority.principal) ||
        (authority.product === "agents" && authority.principal.kind === "human" && conversation.agent_id !== authority.resourceId) ||
        (authority.principal.kind === "visitor" && conversation.deployment_id !== authority.resourceId)) denied();
      const first = (await db.query<TaskRecord>(`SELECT * FROM agents_platform.tasks WHERE organization_id=$1 AND conversation_id=$2
        AND product=$3 AND caller_client_id=$4 AND resource_id=$5 AND parent_task_id IS NULL ORDER BY turn_sequence LIMIT 1`,
      [authority.organizationId, conversationId, authority.product, authority.callerClientId, authority.resourceId])).rows[0] ?? absent();
      if (authority.principal.kind === "automation") await resolveAutomationOwner(db, authority.organizationId, authority.principal);
      else await this.assertPrincipal(db, authority, await this.version(db, authority.organizationId, first.version_id));
      if (cursor.position && !/^\d{1,19}$/.test(cursor.position)) throw new PlatformError("INVALID_CURSOR", 400, "Invalid turn cursor");
      const latest = (await db.query<{ id: string; version_id: string; turn_sequence: string; number: number }>(`SELECT t.id,t.version_id,t.turn_sequence,v.number FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id WHERE t.conversation_id=$1 AND t.parent_task_id IS NULL ORDER BY t.turn_sequence DESC LIMIT 1`,
        [conversationId])).rows[0]!;
      const tasks = (await db.query<TaskRecord & { turn_sequence: string }>(`SELECT * FROM agents_platform.tasks WHERE organization_id=$1 AND conversation_id=$2
        AND product=$3 AND caller_client_id=$4 AND resource_id=$5 AND principal=$6::jsonb AND parent_task_id IS NULL
        AND ($7::bigint IS NULL OR turn_sequence<$7::bigint) AND created_at<=$8 ORDER BY turn_sequence DESC LIMIT $9`,
      [authority.organizationId, conversationId, authority.product, authority.callerClientId, authority.resourceId,
        JSON.stringify(authority.principal), cursor.position || null, cursor.snapshot, query.limit + 1])).rows;
      const page = finishPage(tasks, query.limit, scope, cursor.snapshot, row => ({ position: row.turn_sequence, id: row.id }));
      const items = page.items.reverse().map(task => conversation.deleted_at ? { ...task, input: "[Deleted conversation]", output: null } : task);
      return { ...page, items, conversation: { id: conversationId, agentId: conversation.agent_id, versionId: latest.version_id,
        versionNumber: latest.number, latestTaskId: latest.id, latestTurnSequence: latest.turn_sequence } };
    });
  }

  async getEventPage(authority: AdmissionAuthority, taskId: string, query: PageQuery) {
    const candidate = (await this.pool.query<TaskRecord>("SELECT * FROM agents_platform.tasks WHERE organization_id=$1 AND id=$2",
      [authority.organizationId, taskId])).rows[0] ?? absent();
    const root = await this.getTask(authority, candidate.parent_task_id ? candidate.root_task_id : taskId);
    if (canonicalJson(candidate.principal) !== canonicalJson(root.principal)) denied();
    const scope = { kind: "events", authority, taskId }, cursor = readPageCursor(query.cursor, scope);
    if (cursor.position && !/^\d{1,19}$/.test(cursor.position)) throw new PlatformError("INVALID_CURSOR", 400, "Invalid event cursor");
    const events = (await this.pool.query(`SELECT * FROM agents_platform.task_events WHERE task_id=$1 AND sequence>$2::bigint
      AND created_at<=$3 ORDER BY sequence LIMIT $4`, [taskId, cursor.position || "0", cursor.snapshot, query.limit + 1])).rows;
    return finishPage(events, query.limit, scope, cursor.snapshot, row => ({ position: row.sequence, id: "" }));
  }

  async listTaskEvents(authority: AdmissionAuthority, taskId: string, afterSequence = "0") {
    if (!/^\d{1,19}$/.test(afterSequence) || BigInt(afterSequence) > 9223372036854775807n)
      throw new PlatformError("INVALID_CURSOR", 400, "Invalid event cursor");
    await this.getTask(authority, taskId);
    return (await this.pool.query("SELECT * FROM agents_platform.task_events WHERE task_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 100",
      [taskId, afterSequence])).rows;
  }
}

function denied(): never { throw new PlatformError("ACCESS_DENIED", 403, "Access denied"); }
function absent(): never { throw new PlatformError("NOT_FOUND", 404, "Record not found"); }
