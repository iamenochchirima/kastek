/** Exact queries from the source controller. */
export const SQL = {
  get_usage: [
    "\n        SELECT\n            COALESCE(SUM(CASE WHEN event_type = 'request' THEN quantity ELSE 0 END), 0)::bigint AS requests_this_month,\n            COALESCE(SUM(CASE WHEN event_type = 'token' THEN quantity ELSE 0 END), 0)::bigint AS tokens_this_month,\n            COALESCE(SUM(CASE WHEN event_type = 'conversation' THEN quantity ELSE 0 END), 0)::bigint AS conversations_this_month\n        FROM workspace_usage_events\n        WHERE workspace_id = $1\n          AND created_at >= date_trunc('month', NOW())\n        ",
    "\n        SELECT requests_per_month, tokens_per_month, conversations_per_month\n        FROM workspace_usage_limits\n        WHERE workspace_id = $1\n        LIMIT 1\n        ",
  ],
} as const;
