export const SQL = {
  current_registry_revision:
    "SELECT revision FROM analytics.analytics_rollout_registry WHERE registry_name = 'default'",
  bump_registry_revision:
    "INSERT INTO analytics.analytics_rollout_registry (registry_name, revision)\n           VALUES ('default', 1)\n           ON CONFLICT (registry_name)\n           DO UPDATE SET revision = analytics.analytics_rollout_registry.revision + 1\n           RETURNING revision",
  append_rollout_audit: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
  append_rollout_audit_2:
    "SELECT record_hash FROM analytics.analytics_audit_record WHERE chain_name = $1 ORDER BY chain_sequence DESC LIMIT 1",
  append_rollout_audit_3:
    "INSERT INTO analytics.analytics_audit_record (\n             chain_name, previous_record_hash, record_hash, principal_type, principal_id,\n             reporting_scope_id, operation, request_hash, outcome, correlation_id,\n             policy_version, safe_metadata, occurred_at, created_at\n           ) VALUES ($1,$2,$3,'service',$4,$5,$6,$7,'accepted',$8,$9,$10,$11,$12)",
  evaluate_transaction:
    "SELECT control_id, control_key, control_kind, target_kind, target_key, enabled,\n                  percentage_basis_points, revision, expires_at, removed_at\n           FROM analytics.analytics_rollout_control\n           WHERE control_key = $1\n             AND control_kind = $2\n             AND removed_at IS NULL\n             AND (expires_at IS NULL OR expires_at > $3)",
  upsert_transaction:
    "SELECT control_id, control_key, control_kind, target_kind, target_key, enabled,\n                  percentage_basis_points, revision, expires_at, removed_at\n           FROM analytics.analytics_rollout_control\n           WHERE control_key = $1 AND control_kind = $2 AND target_kind = $3 AND target_key = $4\n           FOR UPDATE",
  upsert_transaction_2:
    "UPDATE analytics.analytics_rollout_control\n               SET enabled = $1, percentage_basis_points = $2, revision = $3,\n                   actor_type = 'service', actor_id = $4, reason = $5, issue_ref = $6,\n                   expires_at = $7, removed_at = $8\n               WHERE control_key = $9 AND control_kind = $10 AND target_kind = $11 AND target_key = $12\n               RETURNING control_id",
  upsert_transaction_3:
    "INSERT INTO analytics.analytics_rollout_control (\n                 control_key, control_kind, target_kind, target_key, enabled,\n                 percentage_basis_points, revision, actor_type, actor_id, reason, issue_ref,\n                 expires_at, removed_at\n               ) VALUES ($1,$2,$3,$4,$5,$6,$7,'service',$8,$9,$10,$11,$12)\n               RETURNING control_id",
  upsert_transaction_4: "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
  upsert_transaction_5:
    "SELECT record_hash FROM analytics.analytics_audit_record WHERE chain_name = $1 ORDER BY chain_sequence DESC LIMIT 1",
  upsert_transaction_6:
    "INSERT INTO analytics.analytics_audit_record (\n             chain_name, previous_record_hash, record_hash, principal_type, principal_id,\n             reporting_scope_id, operation, request_hash, outcome, correlation_id,\n             policy_version, safe_metadata, occurred_at, created_at\n           ) VALUES ($1,$2,$3,'service',$4,$5,$6,$7,'accepted',$8,$9,$10,$11,$12)",
  close_expired_transaction:
    "SELECT control_id, control_key, control_kind, target_kind, target_key, enabled,\n                  percentage_basis_points, revision, expires_at, removed_at\n           FROM analytics.analytics_rollout_control\n           WHERE removed_at IS NULL AND expires_at IS NOT NULL AND expires_at <= $1\n           ORDER BY control_id\n           FOR UPDATE SKIP LOCKED",
  close_expired_transaction_2:
    "UPDATE analytics.analytics_rollout_control\n               SET enabled = FALSE, actor_type = 'service', actor_id = $1,\n                   reason = 'expired automatically', issue_ref = NULL, removed_at = $2\n               WHERE control_id = $3",
} as const;
