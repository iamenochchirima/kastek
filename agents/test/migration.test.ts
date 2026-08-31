import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("foundation migration", () => {
  it("assigns every migration a unique ordered version", async () => {
    const directory = new URL("../migrations/", import.meta.url);
    const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
    const versions = files.map((file) => file.split("_")[0]);
    expect(new Set(versions).size).toBe(versions.length);
    expect(versions).toEqual([...versions].sort());
  });

  it("requires an explicit DDL connection for production migrations", async () => {
    const source = await readFile(new URL("../src/db/migrate.ts", import.meta.url), "utf8");
    expect(source).toContain("AGENTS_MIGRATION_DATABASE_URL");
    expect(source).toContain("is required in production");
  });

  it("adds a durable offer layer without widening ownership", async () => {
    const sql = await readFile(new URL("../migrations/077_consent_gated_handoff.sql", import.meta.url), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS agent_handoff_offers");
    expect(sql).toContain("agent_handoff_offers_pending_conversation_idx");
    expect(sql).toContain("request_source");
    expect(sql).toContain("customer_confirmed");
    expect(sql).toContain("source_message_id");
  });

  it("adds durable workflow node checkpoints with run ownership and idempotency", async () => {
    const sql = await readFile(new URL("../migrations/080_workflow_node_checkpoints.sql", import.meta.url), "utf8");
    expect(sql).toContain("run_workflow_checkpoints");
    expect(sql).toContain("kasitek_validate_run_child_scope");
    expect(sql).toContain("UNIQUE (run_id, idempotency_key)");
    expect(sql).toContain("next_node_id");
  });

  it("indexes active conversation run admission", async () => {
    const sql = await readFile(new URL("../migrations/081_conversation_run_admission.sql", import.meta.url), "utf8");
    expect(sql).toContain("agent_runs_active_conversation_idx");
    expect(sql).toContain("status IN ('received', 'queued', 'running'");
  });

  it("adds an idempotent durable run budget ledger", async () => {
    const sql = await readFile(new URL("../migrations/082_run_budget_ledger.sql", import.meta.url), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS run_budgets");
    expect(sql).toContain("run_budget_reservations");
    expect(sql).toContain("UNIQUE (run_id, reservation_key)");
    expect(sql).toContain("kasitek_validate_run_child_scope");
  });

  it("makes abandoned budget reservations explicitly reconcileable", async () => {
    const sql = await readFile(new URL("../migrations/083_run_budget_reconciliation.sql", import.meta.url), "utf8");
    expect(sql).toContain("'unknown'");
    expect(sql).toContain("reconciliation_required");
    expect(sql).toContain("run_budget_reconciliation_idx");
  });

  it("stores durable model operation outcomes for retry-safe replay", async () => {
    const sql = await readFile(new URL("../migrations/084_durable_model_call_outcomes.sql", import.meta.url), "utf8");
    expect(sql).toContain("operation_key");
    expect(sql).toContain("response JSONB");
    expect(sql).toContain("model_calls_operation_key_uidx");
  });

  it("adds explicit memory review states", async () => {
    const sql = await readFile(new URL("../migrations/085_memory_safety_review_states.sql", import.meta.url), "utf8");
    expect(sql).toContain("review_pending");
    expect(sql).toContain("rejected");
    expect(sql).toContain("superseded");
  });

  it("allows the dual-control operator memory review command", async () => {
    const sql = await readFile(new URL("../migrations/086_operator_memory_review_command.sql", import.meta.url), "utf8");
    expect(sql).toContain("agent_operator_commands_command_type_check");
    expect(sql).toContain("'review_memory'");
  });

  it("stores scoped memory fact lineage without allowing implicit overwrite", async () => {
    const sql = await readFile(new URL("../migrations/087_memory_fact_lineage.sql", import.meta.url), "utf8");
    expect(sql).toContain("fact_key");
    expect(sql).toContain("supersedes_memory_id");
    expect(sql).toContain("status <> 'active'");
    expect(sql).toContain("Memory supersession target is outside the memory scope");
  });

  it("enforces one active conversation run at the database boundary", async () => {
    const sql = await readFile(new URL("../migrations/088_conversation_run_admission_guard.sql", import.meta.url), "utf8");
    expect(sql).toContain("Cannot enforce one active run per conversation");
    expect(sql).toContain("agent_runs_one_active_conversation_uidx");
    expect(sql).toContain("CREATE UNIQUE INDEX");
    expect(sql).toContain("status IN ('received', 'queued', 'running'");
  });

  it("contains the durable scope and run tables", async () => {
    const sql = await readFile(new URL("../migrations/001_agent_platform_foundation.sql", import.meta.url), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS agent_definitions");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS agent_versions");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS agent_installations");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS agent_runs");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS agent_events");
    expect(sql).toContain("UNIQUE (conversation_id, sequence_number)");
    const modelCallsSql = await readFile(new URL("../migrations/002_model_calls.sql", import.meta.url), "utf8");
    expect(modelCallsSql).toContain("CREATE TABLE IF NOT EXISTS model_calls");
    expect(modelCallsSql).toContain("funding_source");
    const memorySql = await readFile(new URL("../migrations/003_memory_knowledge.sql", import.meta.url), "utf8");
    expect(memorySql).toContain("CREATE TABLE IF NOT EXISTS memory_records");
    expect(memorySql).toContain("CREATE TABLE IF NOT EXISTS knowledge_chunks");
    expect(memorySql).toContain("memory_deletion_jobs");
    const eventsSql = await readFile(new URL("../migrations/004_event_envelopes.sql", import.meta.url), "utf8");
    expect(eventsSql).toContain("spec_version");
    expect(eventsSql).toContain("data_content_type");
    const toolInvocationsSql = await readFile(new URL("../migrations/005_tool_invocations.sql", import.meta.url), "utf8");
    expect(toolInvocationsSql).toContain("CREATE TABLE IF NOT EXISTS tool_invocations");
    expect(toolInvocationsSql).toContain("arguments_hash");
    const runDurabilitySql = await readFile(new URL("../migrations/006_run_attempts_and_idempotency.sql", import.meta.url), "utf8");
    expect(runDurabilitySql).toContain("run_attempts");
    expect(runDurabilitySql).toContain("idempotency_key");
    const grantsSql = await readFile(new URL("../migrations/007_tool_grants.sql", import.meta.url), "utf8");
    expect(grantsSql).toContain("agent_tool_grants");
    expect(grantsSql).toContain("effective_idx");
    const summariesSql = await readFile(new URL("../migrations/008_conversation_summaries.sql", import.meta.url), "utf8");
    expect(summariesSql).toContain("conversation_summaries");
    expect(summariesSql).toContain("last_message_sequence");
    const channelsSql = await readFile(new URL("../migrations/009_channels_and_delivery.sql", import.meta.url), "utf8");
    expect(channelsSql).toContain("channel_connections");
    expect(channelsSql).toContain("delivery_attempts");
    const credentialsSql = await readFile(new URL("../migrations/010_credential_vault.sql", import.meta.url), "utf8");
    expect(credentialsSql).toContain("credential_vault");
    expect(credentialsSql).toContain("encrypted_payload");
    const evaluationsSql = await readFile(new URL("../migrations/011_evaluations.sql", import.meta.url), "utf8");
    expect(evaluationsSql).toContain("evaluation_scenarios");
    expect(evaluationsSql).toContain("evaluation_runs");
    const pairingSql = await readFile(new URL("../migrations/012_channel_pairing.sql", import.meta.url), "utf8");
    expect(pairingSql).toContain("channel_pairing_tokens");
    expect(pairingSql).toContain("token_hash");
    const workflowStateSql = await readFile(new URL("../migrations/013_workflow_state.sql", import.meta.url), "utf8");
    expect(workflowStateSql).toContain("run_workflow_state");
    expect(workflowStateSql).toContain("revision");
    const quarantineSql = await readFile(new URL("../migrations/014_memory_quarantine.sql", import.meta.url), "utf8");
    expect(quarantineSql).toContain("quarantined");
    const schedulesSql = await readFile(new URL("../migrations/015_agent_schedules.sql", import.meta.url), "utf8");
    expect(schedulesSql).toContain("agent_schedules");
    expect(schedulesSql).toContain("next_run_at");
    const killSwitchSql = await readFile(new URL("../migrations/016_kill_switches.sql", import.meta.url), "utf8");
    expect(killSwitchSql).toContain("agent_kill_switches");
    expect(killSwitchSql).toContain("scope_type");
    const systemInstallationsSql = await readFile(new URL("../migrations/017_system_agent_installations.sql", import.meta.url), "utf8");
    expect(systemInstallationsSql).toContain("agent_installations_definition_scope_unique_idx");
    const platformChatSql = await readFile(new URL("../migrations/018_platform_chat_delivery.sql", import.meta.url), "utf8");
    expect(platformChatSql).toContain("ADD COLUMN IF NOT EXISTS run_id");
    expect(platformChatSql).toContain("messages_run_direction_idx");
    const correlationSql = await readFile(new URL("../migrations/019_event_correlation.sql", import.meta.url), "utf8");
    expect(correlationSql).toContain("ADD COLUMN IF NOT EXISTS correlation_id");
    expect(correlationSql).toContain("agent_events_correlation_idx");
    const unifiedConversationsSql = await readFile(new URL("../migrations/020_kasiai_unified_conversations.sql", import.meta.url), "utf8");
    expect(unifiedConversationsSql).toContain("owner_actor_id");
    expect(unifiedConversationsSql).toContain("conversations_current_owner_idx");
    expect(unifiedConversationsSql).toContain("source_channel");
    expect(unifiedConversationsSql).toContain("reply_binding_id");
    const primaryHistorySql = await readFile(new URL("../migrations/021_normalize_primary_conversation_history.sql", import.meta.url), "utf8");
    expect(primaryHistorySql).toContain("is_primary = FALSE");
    const verifiedPairingSql = await readFile(new URL("../migrations/022_provider_verified_channel_pairing.sql", import.meta.url), "utf8");
    expect(verifiedPairingSql).toContain("external_identity DROP NOT NULL");
    const providerIdentitySql = await readFile(new URL("../migrations/023_scope_provider_message_identity.sql", import.meta.url), "utf8");
    expect(providerIdentitySql).toContain("organization_id, provider, provider_message_id");
    const workspaceSql = await readFile(new URL("../migrations/024_kasiai_workspace.sql", import.meta.url), "utf8");
    expect(workspaceSql).toContain("title_source");
    expect(workspaceSql).toContain("kasiai_user_preferences");
    expect(workspaceSql).toContain("resolved_model_provider");
    const kasiaiCredentialSql = await readFile(new URL("../migrations/066_kasiai_provider_credentials.sql", import.meta.url), "utf8");
    expect(kasiaiCredentialSql).toContain("default_credential_reference");
    const providerCatalogSql = await readFile(new URL("../migrations/068_model_provider_catalog.sql", import.meta.url), "utf8");
    expect(providerCatalogSql).toContain("opencode_zen");
    expect(providerCatalogSql).toContain("DROP CONSTRAINT IF EXISTS credential_vault_provider_check");
    const effectsSql = await readFile(new URL("../migrations/028_effect_receipts.sql", import.meta.url), "utf8");
    expect(effectsSql).toContain("agent_effect_receipts");
    expect(effectsSql).toContain("reconciliation_required");
    const approvalsSql = await readFile(new URL("../migrations/029_approval_records.sql", import.meta.url), "utf8");
    expect(approvalsSql).toContain("agent_approval_records");
    expect(approvalsSql).toContain("preview_revision");
    const attachmentsSql = await readFile(new URL("../migrations/030_attachment_references.sql", import.meta.url), "utf8");
    expect(attachmentsSql).toContain("agent_attachment_references");
    expect(attachmentsSql).toContain("scan_status");
    const apiScopesSql = await readFile(new URL("../migrations/033_installation_credential_api_scopes.sql", import.meta.url), "utf8");
    expect(apiScopesSql).toContain("api_scopes");
    const receiptStateSql = await readFile(new URL("../migrations/034_effect_receipt_state_semantics.sql", import.meta.url), "utf8");
    expect(receiptStateSql).toContain("DROP CONSTRAINT");
    expect(receiptStateSql).toContain("'unknown'");
    const legacyApprovalSql = await readFile(new URL("../migrations/035_remove_legacy_tool_approval.sql", import.meta.url), "utf8");
    expect(legacyApprovalSql).toContain("DROP COLUMN IF EXISTS approval");
    const clientAssertionsSql = await readFile(new URL("../migrations/036_installation_client_assertions.sql", import.meta.url), "utf8");
    expect(clientAssertionsSql).toContain("client_public_key");
    expect(clientAssertionsSql).toContain("agent_client_assertion_replays");
    expect(clientAssertionsSql).toContain("ON agent_installation_credentials (installation_id, client_key_id)");
    const operatorCommandsSql = await readFile(new URL("../migrations/037_operator_commands.sql", import.meta.url), "utf8");
    expect(operatorCommandsSql).toContain("CREATE TABLE IF NOT EXISTS agent_operator_commands");
    expect(operatorCommandsSql).toContain("required_approvals");
    expect(operatorCommandsSql).toContain("idempotency_key TEXT NOT NULL UNIQUE");
    const operatorProjectionsSql = await readFile(new URL("../migrations/038_operator_projections.sql", import.meta.url), "utf8");
    expect(operatorProjectionsSql).toContain("CREATE TABLE IF NOT EXISTS agent_operator_projections");
    expect(operatorProjectionsSql).toContain("projection_key TEXT PRIMARY KEY");
    expect(operatorProjectionsSql).toContain("CREATE TABLE IF NOT EXISTS agent_operator_notifications");

    const lifecycleCommandsSql = await readFile(new URL("../migrations/039_operator_lifecycle_commands.sql", import.meta.url), "utf8");
    expect(lifecycleCommandsSql).toContain("suspend_installation");
    expect(lifecycleCommandsSql).toContain("revoke_credential");
    const recoveryCommandsSql = await readFile(new URL("../migrations/040_operator_recovery_commands.sql", import.meta.url), "utf8");
    expect(recoveryCommandsSql).toContain("retry_run");
    expect(recoveryCommandsSql).toContain("replay_delivery");
    const memoryDeletionCommandsSql = await readFile(new URL("../migrations/041_operator_memory_deletion.sql", import.meta.url), "utf8");
    expect(memoryDeletionCommandsSql).toContain("delete_memory");
    const runAssignmentsSql = await readFile(new URL("../migrations/042_operator_run_assignments.sql", import.meta.url), "utf8");
    expect(runAssignmentsSql).toContain("agent_operator_run_assignments");
    const exportRequestsSql = await readFile(new URL("../migrations/043_operator_export_requests.sql", import.meta.url), "utf8");
    expect(exportRequestsSql).toContain("agent_export_requests");
    expect(exportRequestsSql).toContain("request_export");
    const operatorControlsSql = await readFile(new URL("../migrations/044_operator_feature_flags_holds.sql", import.meta.url), "utf8");
    expect(operatorControlsSql).toContain("agent_operator_feature_flags");
    expect(operatorControlsSql).toContain("agent_operator_holds");
    expect(operatorControlsSql).toContain("set_feature_flag");
    expect(operatorControlsSql).toContain("release_hold");
    const retentionSql = await readFile(new URL("../migrations/045_retention_legal_holds.sql", import.meta.url), "utf8");
    expect(retentionSql).toContain("agent_retention_policies");
    expect(retentionSql).toContain("agent_legal_holds");
    expect(retentionSql).toContain("apply_retention_policy");
    const auditImmutabilitySql = await readFile(new URL("../migrations/046_immutable_audit_records.sql", import.meta.url), "utf8");
    expect(auditImmutabilitySql).toContain("audit_records_immutable_trigger");
    expect(auditImmutabilitySql).toContain("BEFORE UPDATE OR DELETE");
    expect(auditImmutabilitySql).toContain("append-only");
    const executionModesSql = await readFile(new URL("../migrations/047_installation_execution_modes.sql", import.meta.url), "utf8");
    expect(executionModesSql).toContain("execution_mode");
    expect(executionModesSql).toContain("system_hosted");
    expect(executionModesSql).toContain("kasitek_hosted");
    expect(executionModesSql).toContain("external_connected");
    expect(executionModesSql).toContain("Cannot backfill execution_mode");
    const externalIdempotencySql = await readFile(new URL("../migrations/048_external_connection_idempotency.sql", import.meta.url), "utf8");
    expect(externalIdempotencySql).toContain("agent_external_connection_idempotency_idx");
    expect(externalIdempotencySql).toContain("externalConnectionKey");
    const legacyCredentialSql = await readFile(new URL("../migrations/049_revoke_legacy_mode_credentials.sql", import.meta.url), "utf8");
    expect(legacyCredentialSql).toContain("system:three-mode-remediation");
    expect(legacyCredentialSql).toContain("revoked_legacy_mode");
    const credentialModeGuardSql = await readFile(new URL("../migrations/050_external_credential_mode_guard.sql", import.meta.url), "utf8");
    expect(credentialModeGuardSql).toContain("external_installation_credential_mode_guard");
    expect(credentialModeGuardSql).toContain("external_connected");
    const auditExecutionModeSql = await readFile(new URL("../migrations/051_audit_execution_mode.sql", import.meta.url), "utf8");
    expect(auditExecutionModeSql).toContain("audit_records.execution_mode");
    expect(auditExecutionModeSql).toContain("audit_execution_mode_enrichment_trigger");
    expect(auditExecutionModeSql).toContain("executionMode");
  });

  it("enables the first restricted-role RLS tranche for context records", async () => {
    const sql = await readFile(new URL("../migrations/091_memory_knowledge_rls.sql", import.meta.url), "utf8");
    expect(sql).toContain("kasitek_agents_operator_scope");
    expect(sql).toContain("memory_records_agents_scope");
    expect(sql).toContain("knowledge_sources_agents_scope");
    expect(sql).toContain("knowledge_chunks_agents_scope");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("FORCE ROW LEVEL SECURITY");
  });

  it("enables conversation and durable-run RLS with parent ownership checks", async () => {
    const sql = await readFile(new URL("../migrations/092_conversation_run_rls.sql", import.meta.url), "utf8");
    for (const table of [
      "conversations",
      "participants",
      "messages",
      "conversation_summaries",
      "agent_runs",
      "run_steps",
      "run_attempts",
      "run_workflow_state",
      "run_workflow_checkpoints",
      "run_budgets",
      "run_budget_reservations",
      "model_calls",
      "tool_invocations",
      "agent_events",
      "delivery_attempts",
      "agent_attachment_references",
      "agent_handoff_requests",
      "agent_handoff_offers",
      "agent_operator_run_assignments",
      "evaluation_scenarios",
      "evaluation_runs",
    ]) {
      expect(sql).toContain(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      expect(sql).toContain(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
    }
    expect(sql).toContain("kasitek_agents_current_org_scope");
    expect(sql).toContain("conversation.organization_id = messages.organization_id");
    expect(sql).toContain("installation.organization_id = agent_runs.organization_id");
  });

  it("defines hosted-agent creation profiles", async () => {
    const profileSql = await readFile(new URL("../migrations/054_agent_creation_profiles.sql", import.meta.url), "utf8");
    expect(profileSql).toContain("creation_profile");
    expect(profileSql).toContain("'general'");
    expect(profileSql).toContain("'custom'");
    expect(profileSql).toContain("'system'");
  });

  it("defines agent audiences for personal and customer-service agents", async () => {
    const audienceSql = await readFile(new URL("../migrations/063_agent_audiences.sql", import.meta.url), "utf8");
    expect(audienceSql).toContain("agent_audience");
    expect(audienceSql).toContain("'personal'");
    expect(audienceSql).toContain("'customer_service'");
    expect(audienceSql).toContain("agent_definitions_audience_idx");
  });

  it("defines durable conversation handoff state and requests", async () => {
    const handoffSql = await readFile(new URL("../migrations/064_conversation_handoff_actions.sql", import.meta.url), "utf8");
    expect(handoffSql).toContain("handoff_state");
    expect(handoffSql).toContain("agent_handoff_requests");
    expect(handoffSql).toContain("agent_handoff_requests_active_conversation_idx");
    expect(handoffSql).toContain("idempotency_key");
  });

  it("defines the scoped customer handoff rollout flag", async () => {
    const rolloutSql = await readFile(new URL("../migrations/069_customer_handoff_feature_flag.sql", import.meta.url), "utf8");
    expect(rolloutSql).toContain("customer_handoff_enabled");
    expect(rolloutSql).toContain("organization/installation scoped");
  });

  it("defines durable readiness evaluation leases", async () => {
    const readinessSql = await readFile(new URL("../migrations/071_agent_readiness_evaluation_state.sql", import.meta.url), "utf8");
    expect(readinessSql).toContain("agent_readiness_evaluation_state");
    expect(readinessSql).toContain("lease_expires_at");
    expect(readinessSql).toContain("ON DELETE CASCADE");
  });

  it("defines resumable audio retention and operator deletion state", async () => {
    const audioRetentionSql = await readFile(new URL("../migrations/075_audio_transcription_retention.sql", import.meta.url), "utf8");
    expect(audioRetentionSql).toContain("ADD COLUMN IF NOT EXISTS deleted_at");
    expect(audioRetentionSql).toContain("'deleted'");
    expect(audioRetentionSql).toContain("delete_audio_transcription");
    expect(audioRetentionSql).toContain("audio_transcription_jobs_retention_idx");
  });

  it("defines agent context and aggregate ownership invariants", async () => {
    const scopeSql = await readFile(new URL("../migrations/057_agent_context_and_ownership_invariants.sql", import.meta.url), "utf8");
    expect(scopeSql).toContain("memory_records_agent_scope_required");
    expect(scopeSql).toContain("knowledge_sources_agent_scope_required");
    expect(scopeSql).toContain("kasitek_validate_knowledge_chunk_scope");
    expect(scopeSql).toContain("agent_installations_ownership_trigger");
    expect(scopeSql).toContain("agent_runs_ownership_trigger");
  });

  it("reserves execution modes and the platform sidebar for KasiAi", async () => {
    const modeSql = await readFile(new URL("../migrations/058_execution_mode_and_sidebar_guards.sql", import.meta.url), "utf8");
    expect(modeSql).toContain("agent_installations_execution_mode_guard");
    expect(modeSql).toContain("An agent definition cannot mix execution modes");
    expect(modeSql).toContain("channel_connections_sidebar_guard");
    expect(modeSql).toContain("The protected KasiAi installation owns the platform sidebar");
  });

  it("enforces installation-local conversation and run ownership", async () => {
    const conversationSql = await readFile(new URL("../migrations/059_conversation_ownership_invariants.sql", import.meta.url), "utf8");
    expect(conversationSql).toContain("conversations_ownership_trigger");
    expect(conversationSql).toContain("messages_conversation_scope_trigger");
    expect(conversationSql).toContain("agent_runs_conversation_scope_trigger");
    expect(conversationSql).toContain("run_steps_ownership_trigger");
    expect(conversationSql).toContain("agent_events_ownership_trigger");
  });

  it("allows protected system definitions to be installed in workspace organizations", async () => {
    const systemInstallationSql = await readFile(new URL("../migrations/060_system_installation_ownership.sql", import.meta.url), "utf8");
    expect(systemInstallationSql).toContain("ad.owner_type = 'system'");
    expect(systemInstallationSql).toContain("ad.protected = TRUE");
    expect(systemInstallationSql).toContain("agent_installations_ownership_trigger");
  });

  it("allows runs for protected system definitions installed in workspace organizations", async () => {
    const systemRunSql = await readFile(new URL("../migrations/062_system_run_ownership.sql", import.meta.url), "utf8");
    expect(systemRunSql).toContain("ad.owner_type = 'system'");
    expect(systemRunSql).toContain("ad.protected = TRUE");
    expect(systemRunSql).toContain("agent_runs_ownership_trigger");
  });

  it("contains the durable memory consolidation job trigger", async () => {
    const migration = await readFile(new URL("../migrations/089_memory_consolidation_jobs.sql", import.meta.url), "utf8");
    expect(migration).toContain("memory_consolidation_jobs");
    expect(migration).toContain("messages_memory_consolidation_enqueue_trigger");
    expect(migration).toContain("deterministic-v1");
  });

  it("creates a restricted runtime group without enabling RLS implicitly", async () => {
    const migration = await readFile(new URL("../migrations/090_agents_runtime_role.sql", import.meta.url), "utf8");
    expect(migration).toContain("kasitek_agents_runtime");
    expect(migration).toContain("NOSUPERUSER");
    expect(migration).toContain("NOLOGIN");
    expect(migration).toContain("ALTER DEFAULT PRIVILEGES");
    expect(migration).not.toContain("BYPASSRLS");
    expect(migration).not.toContain("ENABLE ROW LEVEL SECURITY");
  });
});
