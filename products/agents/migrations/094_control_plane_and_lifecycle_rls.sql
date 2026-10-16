-- Fourth RLS tranche: lifecycle sidecars, user preferences, analytics, and
-- operator control-plane data. Operator projections remain operator-only;
-- tenant-facing sidecars are scoped to their organization and owning rows.

DROP POLICY IF EXISTS agent_readiness_evaluation_state_agents_scope ON agent_readiness_evaluation_state;
CREATE POLICY agent_readiness_evaluation_state_agents_scope ON agent_readiness_evaluation_state
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = agent_readiness_evaluation_state.installation_id
        AND installation.organization_id = agent_readiness_evaluation_state.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = agent_readiness_evaluation_state.installation_id
        AND installation.organization_id = agent_readiness_evaluation_state.organization_id
    )
  );
ALTER TABLE agent_readiness_evaluation_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_readiness_evaluation_state FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS memory_consolidation_jobs_agents_scope ON memory_consolidation_jobs;
CREATE POLICY memory_consolidation_jobs_agents_scope ON memory_consolidation_jobs
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND kasitek_agents_visible_definition(agent_definition_id, organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_versions version
      WHERE version.id = memory_consolidation_jobs.agent_version_id
        AND version.agent_definition_id = memory_consolidation_jobs.agent_definition_id
    )
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = memory_consolidation_jobs.installation_id
        AND installation.organization_id = memory_consolidation_jobs.organization_id
        AND installation.agent_definition_id = memory_consolidation_jobs.agent_definition_id
    )
    AND EXISTS (
      SELECT 1 FROM conversations conversation
      WHERE conversation.id = memory_consolidation_jobs.conversation_id
        AND conversation.organization_id = memory_consolidation_jobs.organization_id
        AND conversation.installation_id = memory_consolidation_jobs.installation_id
    )
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = memory_consolidation_jobs.trigger_run_id
        AND run.organization_id = memory_consolidation_jobs.organization_id
        AND run.installation_id = memory_consolidation_jobs.installation_id
        AND run.conversation_id = memory_consolidation_jobs.conversation_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND kasitek_agents_visible_definition(agent_definition_id, organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_versions version
      WHERE version.id = memory_consolidation_jobs.agent_version_id
        AND version.agent_definition_id = memory_consolidation_jobs.agent_definition_id
    )
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = memory_consolidation_jobs.installation_id
        AND installation.organization_id = memory_consolidation_jobs.organization_id
        AND installation.agent_definition_id = memory_consolidation_jobs.agent_definition_id
    )
    AND EXISTS (
      SELECT 1 FROM conversations conversation
      WHERE conversation.id = memory_consolidation_jobs.conversation_id
        AND conversation.organization_id = memory_consolidation_jobs.organization_id
        AND conversation.installation_id = memory_consolidation_jobs.installation_id
    )
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = memory_consolidation_jobs.trigger_run_id
        AND run.organization_id = memory_consolidation_jobs.organization_id
        AND run.installation_id = memory_consolidation_jobs.installation_id
        AND run.conversation_id = memory_consolidation_jobs.conversation_id
    )
  );
ALTER TABLE memory_consolidation_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_consolidation_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audio_transcription_jobs_agents_scope ON audio_transcription_jobs;
CREATE POLICY audio_transcription_jobs_agents_scope ON audio_transcription_jobs
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = audio_transcription_jobs.installation_id
        AND installation.organization_id = audio_transcription_jobs.organization_id
    )
    AND (
      result_run_id IS NULL
      OR EXISTS (
        SELECT 1 FROM agent_runs run
        WHERE run.id = audio_transcription_jobs.result_run_id
          AND run.organization_id = audio_transcription_jobs.organization_id
          AND run.installation_id = audio_transcription_jobs.installation_id
      )
    )
    AND (
      result_conversation_id IS NULL
      OR EXISTS (
        SELECT 1 FROM conversations conversation
        WHERE conversation.id = audio_transcription_jobs.result_conversation_id
          AND conversation.organization_id = audio_transcription_jobs.organization_id
          AND conversation.installation_id = audio_transcription_jobs.installation_id
      )
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = audio_transcription_jobs.installation_id
        AND installation.organization_id = audio_transcription_jobs.organization_id
    )
    AND (
      result_run_id IS NULL
      OR EXISTS (
        SELECT 1 FROM agent_runs run
        WHERE run.id = audio_transcription_jobs.result_run_id
          AND run.organization_id = audio_transcription_jobs.organization_id
          AND run.installation_id = audio_transcription_jobs.installation_id
      )
    )
    AND (
      result_conversation_id IS NULL
      OR EXISTS (
        SELECT 1 FROM conversations conversation
        WHERE conversation.id = audio_transcription_jobs.result_conversation_id
          AND conversation.organization_id = audio_transcription_jobs.organization_id
          AND conversation.installation_id = audio_transcription_jobs.installation_id
      )
    )
  );
ALTER TABLE audio_transcription_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audio_transcription_jobs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS internal_calendar_events_agents_scope ON internal_calendar_events;
CREATE POLICY internal_calendar_events_agents_scope ON internal_calendar_events
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = internal_calendar_events.installation_id
        AND installation.organization_id = internal_calendar_events.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = internal_calendar_events.installation_id
        AND installation.organization_id = internal_calendar_events.organization_id
    )
  );
ALTER TABLE internal_calendar_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_calendar_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kasiai_user_preferences_agents_scope ON kasiai_user_preferences;
CREATE POLICY kasiai_user_preferences_agents_scope ON kasiai_user_preferences
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND owner_actor_id = NULLIF(current_setting('kasitek.actor_id', true), '')
      AND EXISTS (
        SELECT 1 FROM agent_installations installation
        WHERE installation.id = kasiai_user_preferences.installation_id
          AND installation.organization_id = kasiai_user_preferences.organization_id
      )
    )
  )
  WITH CHECK (
    kasitek_agents_operator_scope()
    OR (
      kasitek_agents_current_org_scope(organization_id)
      AND owner_actor_id = NULLIF(current_setting('kasitek.actor_id', true), '')
      AND EXISTS (
        SELECT 1 FROM agent_installations installation
        WHERE installation.id = kasiai_user_preferences.installation_id
          AND installation.organization_id = kasiai_user_preferences.organization_id
      )
    )
  );
ALTER TABLE kasiai_user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE kasiai_user_preferences FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_records_agents_read ON audit_records;
DROP POLICY IF EXISTS audit_records_agents_operator ON audit_records;
DROP POLICY IF EXISTS audit_records_agents_insert ON audit_records;
CREATE POLICY audit_records_agents_read ON audit_records
  FOR SELECT TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope() OR organization_id = NULLIF(current_setting('kasitek.organization_id', true), ''));
CREATE POLICY audit_records_agents_operator ON audit_records
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope())
  WITH CHECK (kasitek_agents_operator_scope());
CREATE POLICY audit_records_agents_insert ON audit_records
  FOR INSERT TO kasitek_agents_runtime
  WITH CHECK (
    organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
  );
ALTER TABLE audit_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS analytics_outbox_agents_read ON analytics_outbox;
DROP POLICY IF EXISTS analytics_outbox_agents_operator ON analytics_outbox;
DROP POLICY IF EXISTS analytics_outbox_agents_insert ON analytics_outbox;
CREATE POLICY analytics_outbox_agents_read ON analytics_outbox
  FOR SELECT TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR source_stream_key LIKE 'organization:' || NULLIF(current_setting('kasitek.organization_id', true), '') || ':%'
  );
CREATE POLICY analytics_outbox_agents_operator ON analytics_outbox
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope())
  WITH CHECK (kasitek_agents_operator_scope());
CREATE POLICY analytics_outbox_agents_insert ON analytics_outbox
  FOR INSERT TO kasitek_agents_runtime
  WITH CHECK (
    source_stream_key LIKE 'organization:' || NULLIF(current_setting('kasitek.organization_id', true), '') || ':%'
  );
ALTER TABLE analytics_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE analytics_outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_retention_policies_agents_read ON agent_retention_policies;
DROP POLICY IF EXISTS agent_retention_policies_agents_operator ON agent_retention_policies;
CREATE POLICY agent_retention_policies_agents_read ON agent_retention_policies
  FOR SELECT TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope() OR organization_id = NULLIF(current_setting('kasitek.organization_id', true), ''));
CREATE POLICY agent_retention_policies_agents_operator ON agent_retention_policies
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope())
  WITH CHECK (kasitek_agents_operator_scope());
ALTER TABLE agent_retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_retention_policies FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_legal_holds_agents_read ON agent_legal_holds;
DROP POLICY IF EXISTS agent_legal_holds_agents_operator ON agent_legal_holds;
CREATE POLICY agent_legal_holds_agents_read ON agent_legal_holds
  FOR SELECT TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope() OR organization_id = NULLIF(current_setting('kasitek.organization_id', true), ''));
CREATE POLICY agent_legal_holds_agents_operator ON agent_legal_holds
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope())
  WITH CHECK (kasitek_agents_operator_scope());
ALTER TABLE agent_legal_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_legal_holds FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_operator_feature_flags_agents_read ON agent_operator_feature_flags;
DROP POLICY IF EXISTS agent_operator_feature_flags_agents_operator ON agent_operator_feature_flags;
DROP POLICY IF EXISTS agent_operator_feature_flags_agents_delete ON agent_operator_feature_flags;
CREATE POLICY agent_operator_feature_flags_agents_read ON agent_operator_feature_flags
  FOR SELECT TO kasitek_agents_runtime
  USING (
    kasitek_agents_operator_scope()
    OR scope_type = 'global'
    OR organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
  );
CREATE POLICY agent_operator_feature_flags_agents_operator ON agent_operator_feature_flags
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope())
  WITH CHECK (kasitek_agents_operator_scope());
CREATE POLICY agent_operator_feature_flags_agents_delete ON agent_operator_feature_flags
  FOR DELETE TO kasitek_agents_runtime
  USING (
    organization_id = NULLIF(current_setting('kasitek.organization_id', true), '')
    AND scope_type <> 'global'
  );
ALTER TABLE agent_operator_feature_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_operator_feature_flags FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_operator_holds_agents_read ON agent_operator_holds;
DROP POLICY IF EXISTS agent_operator_holds_agents_operator ON agent_operator_holds;
DROP POLICY IF EXISTS agent_operator_holds_agents_delete ON agent_operator_holds;
CREATE POLICY agent_operator_holds_agents_read ON agent_operator_holds
  FOR SELECT TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope() OR organization_id = NULLIF(current_setting('kasitek.organization_id', true), ''));
CREATE POLICY agent_operator_holds_agents_operator ON agent_operator_holds
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope())
  WITH CHECK (kasitek_agents_operator_scope());
CREATE POLICY agent_operator_holds_agents_delete ON agent_operator_holds
  FOR DELETE TO kasitek_agents_runtime
  USING (organization_id = NULLIF(current_setting('kasitek.organization_id', true), ''));
ALTER TABLE agent_operator_holds ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_operator_holds FORCE ROW LEVEL SECURITY;

-- These tables deliberately have no tenant-facing write path. Operator
-- authorization is still enforced by the API, while RLS prevents an ordinary
-- runtime request from reading or creating control-plane records directly.
DROP POLICY IF EXISTS agent_export_requests_agents_scope ON agent_export_requests;
CREATE POLICY agent_export_requests_agents_scope ON agent_export_requests
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope())
  WITH CHECK (kasitek_agents_operator_scope());
ALTER TABLE agent_export_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_export_requests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_operator_commands_agents_scope ON agent_operator_commands;
CREATE POLICY agent_operator_commands_agents_scope ON agent_operator_commands
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope())
  WITH CHECK (kasitek_agents_operator_scope());
ALTER TABLE agent_operator_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_operator_commands FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_operator_feature_flags_agents_scope ON agent_operator_feature_flags;
DROP POLICY IF EXISTS agent_operator_holds_agents_scope ON agent_operator_holds;
DROP POLICY IF EXISTS agent_operator_notifications_agents_scope ON agent_operator_notifications;
CREATE POLICY agent_operator_notifications_agents_scope ON agent_operator_notifications
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope())
  WITH CHECK (kasitek_agents_operator_scope());
ALTER TABLE agent_operator_notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_operator_notifications FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_operator_projections_agents_scope ON agent_operator_projections;
CREATE POLICY agent_operator_projections_agents_scope ON agent_operator_projections
  FOR ALL TO kasitek_agents_runtime
  USING (kasitek_agents_operator_scope())
  WITH CHECK (kasitek_agents_operator_scope());
ALTER TABLE agent_operator_projections ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_operator_projections FORCE ROW LEVEL SECURITY;

-- schema_migrations is an administrative ledger, not runtime data. It is
-- intentionally privilege-revoked instead of being exposed through an RLS
-- policy so the application role cannot inspect or alter migration state.
REVOKE ALL ON TABLE schema_migrations FROM kasitek_agents_runtime;
