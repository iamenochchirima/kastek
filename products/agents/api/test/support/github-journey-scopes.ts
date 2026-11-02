import type { Pool } from "pg";
import { connectedToolAuthorityIds, type AgentConfiguration } from "../../src/contracts/contracts";

export interface GithubJourneyScope {
  id: string; parent_task_id: string | null; root_token_limit: number; created_at: Date;
  sources: string[]; bindings: string[]; authority_bindings: string[]; pinned_bindings: string[]; tools: string[]; grant_sources: string[]; grant_bindings: string[];
}

export async function readGithubJourneyScopes(db: Pick<Pool, "query">, rootTaskId: string): Promise<GithubJourneyScope[]> {
  return (await db.query<GithubJourneyScope & { configuration: AgentConfiguration }>(`SELECT t.id,t.parent_task_id,t.root_token_limit,t.created_at,
    coalesce(t.effective_configuration,v.configuration) AS configuration,
    ARRAY(SELECT binding_id FROM agents_platform.version_connected_tools WHERE version_id=v.id ORDER BY binding_id) AS pinned_bindings,
    coalesce(t.effective_configuration,v.configuration)->'sourceRevisionIds' AS sources,
    coalesce(t.effective_configuration,v.configuration)->'connectedToolBindingIds' AS bindings,
    coalesce(t.effective_configuration,v.configuration)->'tools' AS tools,
    g.source_revision_ids AS grant_sources,g.connected_tool_binding_ids AS grant_bindings
    FROM agents_platform.tasks t
    JOIN agents_platform.agent_versions v ON v.id=t.version_id AND v.organization_id=t.organization_id
    JOIN agents_platform.execution_grants g ON g.id=t.grant_id
    WHERE t.root_task_id=$1`, [rootTaskId])).rows.map(({configuration, ...scope}) => ({...scope, authority_bindings: connectedToolAuthorityIds(configuration)}));
}
