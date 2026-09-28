-- Second RLS tranche: conversations, messages, durable runs, and their tenant-owned
-- projections. Every child row is checked against its owning conversation, run, or
-- installation as well as the transaction-local organization.

CREATE OR REPLACE FUNCTION kasitek_agents_current_org_scope(row_organization_id TEXT) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT kasitek_agents_operator_scope()
      OR (
        $1 IS NOT NULL
        AND $1 = NULLIF(current_setting('kasitek.organization_id', true), '')
      );
$$;

GRANT EXECUTE ON FUNCTION kasitek_agents_current_org_scope(TEXT) TO kasitek_agents_runtime;

DROP POLICY IF EXISTS conversations_agents_scope ON conversations;
CREATE POLICY conversations_agents_scope ON conversations
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1
      FROM agent_installations installation
      WHERE installation.id = conversations.installation_id
        AND installation.organization_id = conversations.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1
      FROM agent_installations installation
      WHERE installation.id = conversations.installation_id
        AND installation.organization_id = conversations.organization_id
    )
  );
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS participants_agents_scope ON participants;
CREATE POLICY participants_agents_scope ON participants
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1
      FROM conversations conversation
      WHERE conversation.id = participants.conversation_id
        AND conversation.organization_id = participants.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1
      FROM conversations conversation
      WHERE conversation.id = participants.conversation_id
        AND conversation.organization_id = participants.organization_id
    )
  );
ALTER TABLE participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE participants FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS messages_agents_scope ON messages;
CREATE POLICY messages_agents_scope ON messages
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1
      FROM conversations conversation
      WHERE conversation.id = messages.conversation_id
        AND conversation.organization_id = messages.organization_id
    )
    AND (
      participant_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM participants participant
        WHERE participant.id = messages.participant_id
          AND participant.conversation_id = messages.conversation_id
          AND participant.organization_id = messages.organization_id
      )
    )
    AND (
      run_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM agent_runs run
        WHERE run.id = messages.run_id
          AND run.organization_id = messages.organization_id
          AND run.conversation_id IS NOT DISTINCT FROM messages.conversation_id
      )
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1
      FROM conversations conversation
      WHERE conversation.id = messages.conversation_id
        AND conversation.organization_id = messages.organization_id
    )
    AND (
      participant_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM participants participant
        WHERE participant.id = messages.participant_id
          AND participant.conversation_id = messages.conversation_id
          AND participant.organization_id = messages.organization_id
      )
    )
    AND (
      run_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM agent_runs run
        WHERE run.id = messages.run_id
          AND run.organization_id = messages.organization_id
          AND run.conversation_id IS NOT DISTINCT FROM messages.conversation_id
      )
    )
  );
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS conversation_summaries_agents_scope ON conversation_summaries;
CREATE POLICY conversation_summaries_agents_scope ON conversation_summaries
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1
      FROM conversations conversation
      WHERE conversation.id = conversation_summaries.conversation_id
        AND conversation.organization_id = conversation_summaries.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1
      FROM conversations conversation
      WHERE conversation.id = conversation_summaries.conversation_id
        AND conversation.organization_id = conversation_summaries.organization_id
    )
  );
ALTER TABLE conversation_summaries ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_summaries FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_runs_agents_scope ON agent_runs;
CREATE POLICY agent_runs_agents_scope ON agent_runs
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1
      FROM agent_installations installation
      WHERE installation.id = agent_runs.installation_id
        AND installation.organization_id = agent_runs.organization_id
    )
    AND EXISTS (
      SELECT 1
      FROM agent_definitions definition
      WHERE definition.id = agent_runs.agent_definition_id
        AND (
          definition.organization_id = agent_runs.organization_id
          OR (definition.owner_type = 'system' AND definition.protected = TRUE)
        )
    )
    AND EXISTS (
      SELECT 1
      FROM agent_versions version
      WHERE version.id = agent_runs.agent_version_id
        AND version.agent_definition_id = agent_runs.agent_definition_id
    )
    AND (
      conversation_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM conversations conversation
        WHERE conversation.id = agent_runs.conversation_id
          AND conversation.organization_id = agent_runs.organization_id
      )
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1
      FROM agent_installations installation
      WHERE installation.id = agent_runs.installation_id
        AND installation.organization_id = agent_runs.organization_id
    )
    AND EXISTS (
      SELECT 1
      FROM agent_definitions definition
      WHERE definition.id = agent_runs.agent_definition_id
        AND (
          definition.organization_id = agent_runs.organization_id
          OR (definition.owner_type = 'system' AND definition.protected = TRUE)
        )
    )
    AND EXISTS (
      SELECT 1
      FROM agent_versions version
      WHERE version.id = agent_runs.agent_version_id
        AND version.agent_definition_id = agent_runs.agent_definition_id
    )
    AND (
      conversation_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM conversations conversation
        WHERE conversation.id = agent_runs.conversation_id
          AND conversation.organization_id = agent_runs.organization_id
      )
    )
  );
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS run_steps_agents_scope ON run_steps;
CREATE POLICY run_steps_agents_scope ON run_steps
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = run_steps.run_id AND run.organization_id = run_steps.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = run_steps.run_id AND run.organization_id = run_steps.organization_id
    )
  );
ALTER TABLE run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_steps FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS run_attempts_agents_scope ON run_attempts;
CREATE POLICY run_attempts_agents_scope ON run_attempts
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = run_attempts.run_id AND run.organization_id = run_attempts.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = run_attempts.run_id AND run.organization_id = run_attempts.organization_id
    )
  );
ALTER TABLE run_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_attempts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS run_workflow_state_agents_scope ON run_workflow_state;
CREATE POLICY run_workflow_state_agents_scope ON run_workflow_state
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = run_workflow_state.run_id AND run.organization_id = run_workflow_state.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = run_workflow_state.run_id AND run.organization_id = run_workflow_state.organization_id
    )
  );
ALTER TABLE run_workflow_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_workflow_state FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS run_workflow_checkpoints_agents_scope ON run_workflow_checkpoints;
CREATE POLICY run_workflow_checkpoints_agents_scope ON run_workflow_checkpoints
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = run_workflow_checkpoints.run_id AND run.organization_id = run_workflow_checkpoints.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = run_workflow_checkpoints.run_id AND run.organization_id = run_workflow_checkpoints.organization_id
    )
  );
ALTER TABLE run_workflow_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_workflow_checkpoints FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS run_budgets_agents_scope ON run_budgets;
CREATE POLICY run_budgets_agents_scope ON run_budgets
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = run_budgets.run_id AND run.organization_id = run_budgets.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = run_budgets.run_id AND run.organization_id = run_budgets.organization_id
    )
  );
ALTER TABLE run_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_budgets FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS run_budget_reservations_agents_scope ON run_budget_reservations;
CREATE POLICY run_budget_reservations_agents_scope ON run_budget_reservations
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = run_budget_reservations.run_id AND run.organization_id = run_budget_reservations.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = run_budget_reservations.run_id AND run.organization_id = run_budget_reservations.organization_id
    )
  );
ALTER TABLE run_budget_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_budget_reservations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS model_calls_agents_scope ON model_calls;
CREATE POLICY model_calls_agents_scope ON model_calls
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND (
      run_id IS NULL
      OR EXISTS (
        SELECT 1 FROM agent_runs run
        WHERE run.id = model_calls.run_id AND run.organization_id = model_calls.organization_id
      )
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND (
      run_id IS NULL
      OR EXISTS (
        SELECT 1 FROM agent_runs run
        WHERE run.id = model_calls.run_id AND run.organization_id = model_calls.organization_id
      )
    )
  );
ALTER TABLE model_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_calls FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tool_invocations_agents_scope ON tool_invocations;
CREATE POLICY tool_invocations_agents_scope ON tool_invocations
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = tool_invocations.run_id AND run.organization_id = tool_invocations.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_runs run
      WHERE run.id = tool_invocations.run_id AND run.organization_id = tool_invocations.organization_id
    )
  );
ALTER TABLE tool_invocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_invocations FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_events_agents_scope ON agent_events;
CREATE POLICY agent_events_agents_scope ON agent_events
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND (
      run_id IS NULL
      OR EXISTS (
        SELECT 1 FROM agent_runs run
        WHERE run.id = agent_events.run_id AND run.organization_id = agent_events.organization_id
      )
    )
    AND (
      installation_id IS NULL
      OR EXISTS (
        SELECT 1 FROM agent_installations installation
        WHERE installation.id = agent_events.installation_id AND installation.organization_id = agent_events.organization_id
      )
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND (
      run_id IS NULL
      OR EXISTS (
        SELECT 1 FROM agent_runs run
        WHERE run.id = agent_events.run_id AND run.organization_id = agent_events.organization_id
      )
    )
    AND (
      installation_id IS NULL
      OR EXISTS (
        SELECT 1 FROM agent_installations installation
        WHERE installation.id = agent_events.installation_id AND installation.organization_id = agent_events.organization_id
      )
    )
  );
ALTER TABLE agent_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS delivery_attempts_agents_scope ON delivery_attempts;
CREATE POLICY delivery_attempts_agents_scope ON delivery_attempts
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM conversations conversation
      WHERE conversation.id = delivery_attempts.conversation_id AND conversation.organization_id = delivery_attempts.organization_id
    )
    AND EXISTS (
      SELECT 1 FROM messages message
      WHERE message.id = delivery_attempts.message_id
        AND message.conversation_id = delivery_attempts.conversation_id
        AND message.organization_id = delivery_attempts.organization_id
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM conversations conversation
      WHERE conversation.id = delivery_attempts.conversation_id AND conversation.organization_id = delivery_attempts.organization_id
    )
    AND EXISTS (
      SELECT 1 FROM messages message
      WHERE message.id = delivery_attempts.message_id
        AND message.conversation_id = delivery_attempts.conversation_id
        AND message.organization_id = delivery_attempts.organization_id
    )
  );
ALTER TABLE delivery_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE delivery_attempts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_attachment_references_agents_scope ON agent_attachment_references;
CREATE POLICY agent_attachment_references_agents_scope ON agent_attachment_references
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = agent_attachment_references.installation_id AND installation.organization_id = agent_attachment_references.organization_id
    )
    AND (
      run_id IS NULL
      OR EXISTS (
        SELECT 1 FROM agent_runs run
        WHERE run.id = agent_attachment_references.run_id
          AND run.organization_id = agent_attachment_references.organization_id
          AND run.installation_id = agent_attachment_references.installation_id
      )
    )
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (
      SELECT 1 FROM agent_installations installation
      WHERE installation.id = agent_attachment_references.installation_id AND installation.organization_id = agent_attachment_references.organization_id
    )
    AND (
      run_id IS NULL
      OR EXISTS (
        SELECT 1 FROM agent_runs run
        WHERE run.id = agent_attachment_references.run_id
          AND run.organization_id = agent_attachment_references.organization_id
          AND run.installation_id = agent_attachment_references.installation_id
      )
    )
  );
ALTER TABLE agent_attachment_references ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_attachment_references FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_handoff_requests_agents_scope ON agent_handoff_requests;
CREATE POLICY agent_handoff_requests_agents_scope ON agent_handoff_requests
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM conversations conversation WHERE conversation.id = agent_handoff_requests.conversation_id AND conversation.organization_id = agent_handoff_requests.organization_id)
    AND EXISTS (SELECT 1 FROM agent_installations installation WHERE installation.id = agent_handoff_requests.installation_id AND installation.organization_id = agent_handoff_requests.organization_id)
    AND EXISTS (SELECT 1 FROM agent_definitions definition WHERE definition.id = agent_handoff_requests.agent_definition_id AND (definition.organization_id = agent_handoff_requests.organization_id OR (definition.owner_type = 'system' AND definition.protected = TRUE)))
    AND EXISTS (SELECT 1 FROM agent_versions version WHERE version.id = agent_handoff_requests.agent_version_id AND version.agent_definition_id = agent_handoff_requests.agent_definition_id)
    AND (run_id IS NULL OR EXISTS (SELECT 1 FROM agent_runs run WHERE run.id = agent_handoff_requests.run_id AND run.organization_id = agent_handoff_requests.organization_id AND run.conversation_id = agent_handoff_requests.conversation_id))
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM conversations conversation WHERE conversation.id = agent_handoff_requests.conversation_id AND conversation.organization_id = agent_handoff_requests.organization_id)
    AND EXISTS (SELECT 1 FROM agent_installations installation WHERE installation.id = agent_handoff_requests.installation_id AND installation.organization_id = agent_handoff_requests.organization_id)
    AND EXISTS (SELECT 1 FROM agent_definitions definition WHERE definition.id = agent_handoff_requests.agent_definition_id AND (definition.organization_id = agent_handoff_requests.organization_id OR (definition.owner_type = 'system' AND definition.protected = TRUE)))
    AND EXISTS (SELECT 1 FROM agent_versions version WHERE version.id = agent_handoff_requests.agent_version_id AND version.agent_definition_id = agent_handoff_requests.agent_definition_id)
    AND (run_id IS NULL OR EXISTS (SELECT 1 FROM agent_runs run WHERE run.id = agent_handoff_requests.run_id AND run.organization_id = agent_handoff_requests.organization_id AND run.conversation_id = agent_handoff_requests.conversation_id))
  );
ALTER TABLE agent_handoff_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_handoff_requests FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_handoff_offers_agents_scope ON agent_handoff_offers;
CREATE POLICY agent_handoff_offers_agents_scope ON agent_handoff_offers
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM conversations conversation WHERE conversation.id = agent_handoff_offers.conversation_id AND conversation.organization_id = agent_handoff_offers.organization_id)
    AND EXISTS (SELECT 1 FROM agent_installations installation WHERE installation.id = agent_handoff_offers.installation_id AND installation.organization_id = agent_handoff_offers.organization_id)
    AND EXISTS (SELECT 1 FROM agent_definitions definition WHERE definition.id = agent_handoff_offers.agent_definition_id AND (definition.organization_id = agent_handoff_offers.organization_id OR (definition.owner_type = 'system' AND definition.protected = TRUE)))
    AND EXISTS (SELECT 1 FROM agent_versions version WHERE version.id = agent_handoff_offers.agent_version_id AND version.agent_definition_id = agent_handoff_offers.agent_definition_id)
    AND (source_run_id IS NULL OR EXISTS (SELECT 1 FROM agent_runs run WHERE run.id = agent_handoff_offers.source_run_id AND run.organization_id = agent_handoff_offers.organization_id AND run.conversation_id = agent_handoff_offers.conversation_id))
    AND (source_message_id IS NULL OR EXISTS (SELECT 1 FROM messages message WHERE message.id = agent_handoff_offers.source_message_id AND message.organization_id = agent_handoff_offers.organization_id AND message.conversation_id = agent_handoff_offers.conversation_id))
    AND (decision_message_id IS NULL OR EXISTS (SELECT 1 FROM messages message WHERE message.id = agent_handoff_offers.decision_message_id AND message.organization_id = agent_handoff_offers.organization_id AND message.conversation_id = agent_handoff_offers.conversation_id))
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM conversations conversation WHERE conversation.id = agent_handoff_offers.conversation_id AND conversation.organization_id = agent_handoff_offers.organization_id)
    AND EXISTS (SELECT 1 FROM agent_installations installation WHERE installation.id = agent_handoff_offers.installation_id AND installation.organization_id = agent_handoff_offers.organization_id)
    AND EXISTS (SELECT 1 FROM agent_definitions definition WHERE definition.id = agent_handoff_offers.agent_definition_id AND (definition.organization_id = agent_handoff_offers.organization_id OR (definition.owner_type = 'system' AND definition.protected = TRUE)))
    AND EXISTS (SELECT 1 FROM agent_versions version WHERE version.id = agent_handoff_offers.agent_version_id AND version.agent_definition_id = agent_handoff_offers.agent_definition_id)
    AND (source_run_id IS NULL OR EXISTS (SELECT 1 FROM agent_runs run WHERE run.id = agent_handoff_offers.source_run_id AND run.organization_id = agent_handoff_offers.organization_id AND run.conversation_id = agent_handoff_offers.conversation_id))
    AND (source_message_id IS NULL OR EXISTS (SELECT 1 FROM messages message WHERE message.id = agent_handoff_offers.source_message_id AND message.organization_id = agent_handoff_offers.organization_id AND message.conversation_id = agent_handoff_offers.conversation_id))
    AND (decision_message_id IS NULL OR EXISTS (SELECT 1 FROM messages message WHERE message.id = agent_handoff_offers.decision_message_id AND message.organization_id = agent_handoff_offers.organization_id AND message.conversation_id = agent_handoff_offers.conversation_id))
  );
ALTER TABLE agent_handoff_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_handoff_offers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_operator_run_assignments_agents_scope ON agent_operator_run_assignments;
CREATE POLICY agent_operator_run_assignments_agents_scope ON agent_operator_run_assignments
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM agent_runs run WHERE run.id = agent_operator_run_assignments.run_id AND run.organization_id = agent_operator_run_assignments.organization_id)
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM agent_runs run WHERE run.id = agent_operator_run_assignments.run_id AND run.organization_id = agent_operator_run_assignments.organization_id)
  );
ALTER TABLE agent_operator_run_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_operator_run_assignments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS evaluation_scenarios_agents_scope ON evaluation_scenarios;
CREATE POLICY evaluation_scenarios_agents_scope ON evaluation_scenarios
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND (agent_definition_id IS NULL OR EXISTS (
      SELECT 1 FROM agent_definitions definition
      WHERE definition.id = evaluation_scenarios.agent_definition_id
        AND (definition.organization_id = evaluation_scenarios.organization_id OR (definition.owner_type = 'system' AND definition.protected = TRUE))
    ))
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND (agent_definition_id IS NULL OR EXISTS (
      SELECT 1 FROM agent_definitions definition
      WHERE definition.id = evaluation_scenarios.agent_definition_id
        AND (definition.organization_id = evaluation_scenarios.organization_id OR (definition.owner_type = 'system' AND definition.protected = TRUE))
    ))
  );
ALTER TABLE evaluation_scenarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_scenarios FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS evaluation_runs_agents_scope ON evaluation_runs;
CREATE POLICY evaluation_runs_agents_scope ON evaluation_runs
  FOR ALL TO kasitek_agents_runtime
  USING (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM evaluation_scenarios scenario WHERE scenario.id = evaluation_runs.scenario_id AND scenario.organization_id = evaluation_runs.organization_id)
    AND (run_id IS NULL OR EXISTS (SELECT 1 FROM agent_runs run WHERE run.id = evaluation_runs.run_id AND run.organization_id = evaluation_runs.organization_id))
  )
  WITH CHECK (
    kasitek_agents_current_org_scope(organization_id)
    AND EXISTS (SELECT 1 FROM evaluation_scenarios scenario WHERE scenario.id = evaluation_runs.scenario_id AND scenario.organization_id = evaluation_runs.organization_id)
    AND (run_id IS NULL OR EXISTS (SELECT 1 FROM agent_runs run WHERE run.id = evaluation_runs.run_id AND run.organization_id = evaluation_runs.organization_id))
  );
ALTER TABLE evaluation_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE evaluation_runs FORCE ROW LEVEL SECURITY;
