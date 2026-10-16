import type { Pool } from "pg";
import { query } from "../pool";
import type { MessageRecord } from "./conversation-repository";

export interface ConversationSummaryRecord {
  conversation_id: string;
  organization_id: string;
  summary: string;
  summary_version: number;
  last_message_sequence: number;
  generated_by: string;
  created_at: string;
  updated_at: string;
}

export class SummaryRepository {
  public constructor(private readonly pool: Pool) {}

  public async getSummary(organizationId: string, conversationId: string): Promise<ConversationSummaryRecord | null> {
    const result = await query<ConversationSummaryRecord>(
      this.pool,
      `SELECT * FROM conversation_summaries WHERE organization_id = $1 AND conversation_id = $2`,
      [organizationId, conversationId],
    );
    const summary = result.rows[0];
    return summary ? { ...summary, last_message_sequence: Number(summary.last_message_sequence) } : null;
  }

  public async upsertSummary(input: {
    organizationId: string;
    conversationId: string;
    summary: string;
    lastMessageSequence: number;
    generatedBy?: string;
  }): Promise<ConversationSummaryRecord> {
    const result = await query<ConversationSummaryRecord>(
      this.pool,
      `INSERT INTO conversation_summaries
        (conversation_id, organization_id, summary, last_message_sequence, generated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (conversation_id) DO UPDATE SET
         summary = EXCLUDED.summary,
         last_message_sequence = EXCLUDED.last_message_sequence,
         generated_by = EXCLUDED.generated_by,
         summary_version = conversation_summaries.summary_version + 1,
         updated_at = now()
       WHERE conversation_summaries.organization_id = EXCLUDED.organization_id
       RETURNING *`,
      [input.conversationId, input.organizationId, input.summary, input.lastMessageSequence, input.generatedBy ?? "deterministic-v1"],
    );
    if (!result.rows[0]) throw new Error("Conversation summary scope conflict");
    return { ...result.rows[0], last_message_sequence: Number(result.rows[0].last_message_sequence) };
  }

  public async rebuildFromMessages(input: {
    organizationId: string;
    conversationId: string;
    messages: MessageRecord[];
    maxCharacters?: number;
  }): Promise<ConversationSummaryRecord> {
    const maxCharacters = input.maxCharacters ?? 4_000;
    const lines = input.messages
      .slice(-40)
      .map((message) => {
        const text = typeof message.content.text === "string" ? message.content.text : JSON.stringify(message.content);
        return `${message.direction}: ${text}`;
      });
    const summary = lines.join("\n").slice(-maxCharacters) || "No conversation history yet.";
    const lastMessageSequence = Number(input.messages.at(-1)?.sequence_number ?? 0);
    return this.upsertSummary({
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      summary,
      lastMessageSequence,
    });
  }
}
