import type { Pool } from "pg";
import { agentConfigurationSchema } from "../../contracts/contracts";
import { dispatchBoundModel } from "../../execution/models/dispatch";
import { resolveAcceptedModelRoutes } from "../../execution/models/resolution";
import { contextGrantCeiling, executionModelLayers } from "../../execution/models/settings";
import { transaction } from "../../infrastructure/database";
import type { ModelProviderStore } from "../model-providers/store";

const titlePrompt = "Create a short title for this conversation. Reply with only the title, using 3 to 6 words. Describe the user's request, not the assistant's reply. Use the user's language. Do not use quotes, markdown, or ending punctuation.";

/** Model output is untrusted; only a plain, bounded title reaches storage. */
export function sanitizeConversationTitle(value: string): string {
  let title = value.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  title = title.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "").trim();
  title = title.replace(/^(?:conversation\s+)?title\s*[:\-]\s*/i, "").trim();
  title = title.replace(/^["'`“”‘’]+|["'`“”‘’]+$/g, "").trim();
  title = title.replace(/[.!?;:]+$/g, "").trim();
  if (!title || /^(?:untitled|conversation|chat|new chat)$/i.test(title)) return "";
  return title.length > 120 ? title.slice(0, 120).replace(/\s+\S*$/, "").trim() : title;
}

/** Best-effort title generation for the first turn of an internal conversation. */
export async function generateConversationTitle(options: {
  pool: Pool;
  providers: Pick<ModelProviderStore, "resolveCredential">;
  taskId: string;
}): Promise<string | null> {
  if (process.env.NODE_ENV === "test" || process.env.AGENTS_CONVERSATION_TITLES === "false") return null;
  const row = (await options.pool.query<{ turn_sequence: string; product: string; organization_id: string; conversation_id: string; agent_id: string; title: string | null; version_id: string; input: string }>(`
    SELECT t.turn_sequence,t.product,t.organization_id,t.conversation_id,t.version_id,t.input,c.agent_id,c.title
    FROM agents_platform.tasks t
    JOIN agents_platform.conversations c ON c.id=t.conversation_id AND c.organization_id=t.organization_id
    WHERE t.id=$1 AND t.parent_task_id IS NULL AND c.deleted_at IS NULL AND c.deployment_id IS NULL
      AND t.principal->>'kind'='human'`, [options.taskId])).rows[0];
  if (!row || row.product !== "agents" || BigInt(row.turn_sequence) !== 1n || row.title || !row.input.trim()) return null;
  const version = (await options.pool.query<{ configuration: unknown }>("SELECT configuration FROM agents_platform.agent_versions WHERE organization_id=$1 AND id=$2", [row.organization_id, row.version_id])).rows[0];
  if (!version) return null;
  const configuration = agentConfigurationSchema.parse(version.configuration);
  const grant = {
    id: `conversation-title:${row.conversation_id}`,
    maxInputBytes: Math.min(configuration.model.maxInputBytes, 8_192),
    maxOutputTokens: Math.min(configuration.model.maxOutputTokens, 64),
    maxContextTokens: Math.min(contextGrantCeiling(configuration), 16_384),
    rootTokenLimit: 16_384,
  };
  const routes = await transaction(options.pool, db => resolveAcceptedModelRoutes(db, {
    organizationId: row.organization_id, agentId: row.agent_id, product: "agents",
    selection: configuration.model.selection, generation: configuration.model.generation,
    layers: executionModelLayers(configuration, grant), requiresTools: false,
  }));
  const response = await dispatchBoundModel({
    pool: options.pool, providerStore: options.providers, accepted: routes.primary,
    messages: [{ role: "system", content: titlePrompt }, { role: "user", content: row.input.slice(0, 2_000) }],
    maxRequestBytes: 8_192, deadlineAt: Date.now() + 15_000,
  });
  const title = sanitizeConversationTitle(response.message.content ?? "");
  if (!title) return null;
  const updated = await options.pool.query("UPDATE agents_platform.conversations SET title=$3 WHERE organization_id=$1 AND id=$2 AND title IS NULL", [row.organization_id, row.conversation_id, title]);
  return updated.rowCount ? title : null;
}
