/** Exact queries from the source controller. */
export const SQL = {
  list_conversations: [
    "\n        SELECT\n            id,\n            external_id,\n            channel,\n            customer_identifier,\n            customer_name,\n            status,\n            metadata,\n            last_message_at,\n            created_at,\n            updated_at\n        FROM conversations\n        WHERE workspace_id = $1\n        ORDER BY last_message_at DESC, updated_at DESC\n        ",
  ],
  get_conversation: [
    "\n        SELECT\n            id,\n            external_id,\n            channel,\n            customer_identifier,\n            customer_name,\n            status,\n            metadata,\n            last_message_at,\n            created_at,\n            updated_at\n        FROM conversations\n        WHERE workspace_id = $1 AND id = $2\n        LIMIT 1\n        ",
  ],
  list_messages: [
    "\n        SELECT id\n        FROM conversations\n        WHERE workspace_id = $1 AND id = $2\n        LIMIT 1\n        ",
    "\n        SELECT\n            id,\n            sender_role,\n            content,\n            metadata,\n            created_at\n        FROM messages\n        WHERE workspace_id = $1 AND conversation_id = $2\n        ORDER BY created_at ASC\n        ",
  ],
} as const;
