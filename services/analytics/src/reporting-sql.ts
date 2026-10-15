export const AUTHORIZE_TRANSACTION_0 =
  "SELECT service_identity_id\n           FROM analytics.service_identity\n           WHERE issuer = $1 AND status = 'active'";
export const AUTHORIZE_TRANSACTION_1 =
  'INSERT INTO analytics.reporting_grant (\n             grant_id, issuer_service_identity_id, audience, principal_type, principal_id,\n             scope_id, root_scope_id, descendant_mode, explicit_descendant_scope_ids,\n             permissions, metric_keys, dimension_keys, policy_version, issued_at, not_before,\n             expires_at, correlation_id\n           ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)\n           ON CONFLICT (grant_id) DO NOTHING';
export const AUTHORIZE_TRANSACTION_2 =
  'SELECT g.issuer_service_identity_id, g.audience, g.principal_type, g.principal_id, g.scope_id, g.root_scope_id,\n                  g.descendant_mode, g.explicit_descendant_scope_ids, g.permissions,\n                  g.metric_keys, g.dimension_keys, g.policy_version, g.issued_at,\n                  g.not_before, g.expires_at, g.correlation_id, g.revoked_at, si.issuer\n           FROM analytics.reporting_grant AS g\n           JOIN analytics.service_identity AS si\n             ON si.service_identity_id = g.issuer_service_identity_id\n           WHERE g.grant_id = $1';
export const AUTHORIZE_TRANSACTION_3 =
  'SELECT scope_id, scope_kind, root_scope_id, status, reporting_timezone\n           FROM analytics.reporting_scope\n           WHERE scope_id = $1';
export const AUTHORIZE_TRANSACTION_4 =
  "SELECT EXISTS (\n                         SELECT 1\n                         FROM analytics.scope_ancestor AS hierarchy\n                         JOIN analytics.reporting_scope AS scope\n                           ON scope.scope_id = hierarchy.descendant_scope_id\n                         WHERE hierarchy.ancestor_scope_id = $1\n                           AND hierarchy.descendant_scope_id = $2\n                           AND scope.root_scope_id = $3\n                           AND scope.status = 'active'\n                       )";
export const AUTHORIZE_TRANSACTION_5 =
  'SELECT scope_id\n                   FROM analytics.authorized_active_descendant_scope_ids($1)\n                   LIMIT $2';
export const AUTHORIZE_TRANSACTION_6 =
  "SELECT EXISTS (SELECT 1 FROM analytics.reporting_scope WHERE scope_id = $1 AND root_scope_id = $2 AND status = 'active')";
export const AUTHORIZE_TRANSACTION_7 =
  'SELECT EXISTS (SELECT 1 FROM analytics.scope_ancestor WHERE ancestor_scope_id = $1 AND descendant_scope_id = $2)';
export const LOAD_GENERATION_0 =
  "SELECT checkpoint.generation_id, checkpoint.processing_status,\n                  generation.projection_version, generation.metric_registry_sha256\n           FROM analytics.analytics_projection_checkpoint AS checkpoint\n           JOIN analytics.analytics_projection_generation AS generation\n             ON generation.generation_id = checkpoint.generation_id\n           WHERE checkpoint.projection_name = $1\n             AND checkpoint.projection_version = $2\n             AND checkpoint.reporting_scope_id = $3\n             AND checkpoint.shard_key = $4\n             AND generation.generation_status = 'promoted'";
export const LOAD_SOURCE_AVAILABILITY_0 =
  'SELECT metric_scope, availability_state, safe_failure_code, latest_source_timestamp\n           FROM analytics.analytics_source_state\n           WHERE reporting_scope_id = ANY($1::bigint[])\n             AND metric_scope = ANY($2::text[])\n           ORDER BY updated_at DESC';
export const LOAD_COVERAGE_AVAILABILITY_0 =
  "SELECT source_domain, reporting_scope_id, coverage_layer, window_start, window_end,\n                  coverage_state, complete_through, observed_at\n           FROM analytics.analytics_coverage_checkpoint\n           WHERE reporting_scope_id = ANY($1::bigint[])\n             AND source_domain = ANY($2::text[])\n             AND window_end > $3\n             AND window_start < $4\n             AND coverage_layer IN ('temporal', 'reconciliation')\n           ORDER BY source_domain, reporting_scope_id,\n                    CASE coverage_layer WHEN 'temporal' THEN 2 ELSE 1 END DESC,\n                    observed_at DESC";
export const LOAD_COVERAGE_AVAILABILITY_1 =
  "SELECT source_domain, reporting_scope_id, requested_range_start, requested_range_end\n           FROM analytics.analytics_backfill_job\n           WHERE reporting_scope_id = ANY($1::bigint[])\n             AND source_domain = ANY($2::text[])\n             AND job_status IN ('queued', 'running', 'paused')\n             AND requested_range_end > $3\n             AND requested_range_start < $4";
