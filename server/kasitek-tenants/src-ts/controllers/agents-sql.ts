/** Exact queries from the source controller. */
export const SQL = {
  list_agents: [
    "\n        SELECT\n            id,\n            name,\n            status,\n            config,\n            created_at,\n            updated_at\n        FROM workspace_agents\n        WHERE workspace_id = $1\n        ORDER BY updated_at DESC, created_at DESC\n        ",
  ],
  get_agent: [
    "\n        SELECT\n            id,\n            name,\n            status,\n            config,\n            created_at,\n            updated_at\n        FROM workspace_agents\n        WHERE workspace_id = $1 AND id = $2\n        LIMIT 1\n        ",
  ],
} as const;
