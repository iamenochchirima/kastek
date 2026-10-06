/** Exact queries from the source controller. */
export const SQL = {
  get_overview: [
    "\n        SELECT\n            (\n                SELECT COUNT(*)\n                FROM tenant_client_users\n                WHERE workspace_id = $1 AND tenant_client_id = $2 AND status = 'active'\n            ) AS total_users,\n            (\n                SELECT COUNT(*)\n                FROM conversations\n                WHERE workspace_id = $1 AND tenant_client_id = $2\n            ) AS total_conversations,\n            (\n                SELECT COUNT(*)\n                FROM conversations\n                WHERE workspace_id = $1\n                  AND tenant_client_id = $2\n                  AND status IN ('active', 'open')\n            ) AS unread_or_open_conversations,\n            (\n                SELECT COUNT(*)\n                FROM messages m\n                JOIN conversations c ON c.id = m.conversation_id\n                WHERE m.workspace_id = $1 AND c.tenant_client_id = $2\n            ) AS total_messages\n        ",
  ],
  list_conversations: [
    "\n        SELECT\n            id,\n            external_id,\n            channel,\n            customer_identifier,\n            customer_name,\n            status,\n            metadata,\n            last_message_at,\n            created_at,\n            updated_at\n        FROM conversations\n        WHERE workspace_id = $1\n          AND tenant_client_id = $2\n        ORDER BY last_message_at DESC, updated_at DESC\n        ",
  ],
  get_conversation: [
    "\n        SELECT\n            id,\n            external_id,\n            channel,\n            customer_identifier,\n            customer_name,\n            status,\n            metadata,\n            last_message_at,\n            created_at,\n            updated_at\n        FROM conversations\n        WHERE workspace_id = $1\n          AND tenant_client_id = $2\n          AND id = $3\n        LIMIT 1\n        ",
  ],
  list_messages: [
    "\n        SELECT\n            id,\n            sender_role,\n            content,\n            metadata,\n            created_at\n        FROM messages\n        WHERE workspace_id = $1\n          AND conversation_id = $2\n        ORDER BY created_at ASC\n        ",
  ],
} as const;
