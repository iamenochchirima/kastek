ALTER TABLE agent_operator_commands
  DROP CONSTRAINT IF EXISTS agent_operator_commands_command_type_check;

ALTER TABLE agent_operator_commands
  ADD CONSTRAINT agent_operator_commands_command_type_check
  CHECK (command_type IN (
    'cancel_run',
    'retry_run',
    'replay_delivery',
    'delete_memory',
    'reconcile_effect',
    'kill_switch_enable',
    'kill_switch_disable',
    'suspend_installation',
    'resume_installation',
    'revoke_credential',
    'pause_schedule',
    'resume_schedule'
  ));
