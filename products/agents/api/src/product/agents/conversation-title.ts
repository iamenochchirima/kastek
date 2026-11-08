import type { Pool } from "pg";
import { agentConfigurationSchema } from "../../contracts/contracts";
import { dispatchBoundModel } from "../../execution/models/dispatch";
import { resolveAcceptedModelRoutes } from "../../execution/models/resolution";
import { contextGrantCeiling, executionModelLayers } from "../../execution/models/settings";
import { transaction } from "../../infrastructure/database";
import type { ModelProviderStore } from "../model-providers/store";

const titlePrompt = "Write a short chat title for this exchange. Use 3 to 6 words in title case. Describe the topic, not the greeting or the assistant's answer. Return only the title, without quotes or ending punctuation. Examples: \"Refund for damaged order\", \"Weekend platter ideas\", \"Facebook page connection\".";

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

/** Decide whether the stored title is still a fallback that may be replaced. */
export function shouldGenerateConversationTitle(input: {
  product: "agents" | "growth" | "agencies";
  conversationTitle: string | null;
  productTitle: string | null;
  inputPrefix: string;
}): boolean {
  if (input.product === "agents") return !input.conversationTitle;
  return Boolean(input.productTitle) && (input.productTitle === "New conversation" || input.productTitle === input.inputPrefix);
}

/** Best-effort title generation for the first turn of an internal conversation. */
export async function generateConversationTitle(options: {
  pool: Pool;
  providers: Pick<ModelProviderStore, "resolveCredential">;
  taskId: string;
}): Promise<string | null> {
  if (process.env.NODE_ENV === "test" || process.env.AGENTS_CONVERSATION_TITLES === "false") return null;
  const row = (await options.pool.query<{ turn_sequence: string; product: "agents" | "growth" | "agencies"; organization_id: string; conversation_id: string; agent_id: string; title: string | null; product_title: string | null; input_prefix: string; version_id: string; input: string; output: string | null }>(`
    SELECT t.turn_sequence,t.product,t.organization_id,t.conversation_id,t.version_id,t.input,t.output,c.agent_id,c.title,
      left(t.input,80) AS input_prefix,p.title AS product_title
    FROM agents_platform.tasks t
    JOIN agents_platform.conversations c ON c.id=t.conversation_id AND c.organization_id=t.organization_id
    LEFT JOIN agents_platform.product_conversations p ON p.conversation_id=t.conversation_id AND p.product=t.product
    WHERE t.id=$1 AND t.parent_task_id IS NULL AND c.deleted_at IS NULL AND c.deployment_id IS NULL
      AND t.principal->>'kind'='human'`, [options.taskId])).rows[0];
  if (!row || BigInt(row.turn_sequence) !== 1n || !row.input.trim()) return null;
  if (!shouldGenerateConversationTitle({ product: row.product, conversationTitle: row.title, productTitle: row.product_title, inputPrefix: row.input_prefix })) return null;
  const version = (await options.pool.query<{ configuration: unknown }>("SELECT configuration FROM agents_platform.agent_versions WHERE organization_id=$1 AND id=$2", [row.organization_id, row.version_id])).rows[0];
  if (!version) return null;
  const configuration = agentConfigurationSchema.parse(version.configuration);
  const grant = {
    id: `conversation-title:${row.conversation_id}`,
    maxInputBytes: Math.min(configuration.model.maxInputBytes, 8_192),
    maxOutputTokens: Math.min(configuration.model.maxOutputTokens, 4_096),
    maxContextTokens: Math.min(contextGrantCeiling(configuration), 32_768),
    rootTokenLimit: 32_768,
  };
  const routes = await transaction(options.pool, db => resolveAcceptedModelRoutes(db, {
    organizationId: row.organization_id, agentId: row.agent_id, product: row.product,
    selection: configuration.model.selection, generation: configuration.model.generation,
    layers: executionModelLayers(configuration, grant), requiresTools: false,
  }));
  const response = await dispatchBoundModel({
    pool: options.pool, providerStore: options.providers, accepted: routes.primary,
    messages: [{ role: "system", content: titlePrompt }, { role: "user", content: `Customer: ${row.input.slice(0, 2_000)}${row.output ? `\n\nAssistant: ${row.output.slice(0, 1_500)}` : ""}` }],
    maxRequestBytes: 12_288, deadlineAt: Date.now() + 60_000,
  });
  const title = sanitizeConversationTitle(response.message.content ?? "");
  if (!title) return null;
  const updated = row.product === "agents"
    ? await options.pool.query("UPDATE agents_platform.conversations SET title=$3 WHERE organization_id=$1 AND id=$2 AND title IS NULL", [row.organization_id, row.conversation_id, title])
    : await options.pool.query("UPDATE agents_platform.product_conversations SET title=$3 WHERE conversation_id=$1 AND product=$2 AND (title='New conversation' OR title=$4)", [row.conversation_id, row.product, title, row.input_prefix]);
  return updated.rowCount ? title : null;
}
