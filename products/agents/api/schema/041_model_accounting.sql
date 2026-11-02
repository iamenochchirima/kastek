-- Bounds below describe PostgreSQL integer storage, not provider capacity or platform policy.
ALTER TABLE agents_platform.execution_grants
 DROP CONSTRAINT execution_grants_max_output_tokens_check,
 DROP CONSTRAINT execution_grants_max_context_tokens_check,
 DROP CONSTRAINT execution_grants_root_token_limit_check,
 ADD CHECK(max_output_tokens BETWEEN 1 AND 2147483647),
 ADD CHECK(max_context_tokens BETWEEN 1 AND 2147483647),
 ADD CHECK(root_token_limit BETWEEN 1 AND 2147483647);
ALTER TABLE agents_platform.tasks
 DROP CONSTRAINT tasks_root_token_limit_check,
 DROP CONSTRAINT tasks_model_calls_check,
 DROP CONSTRAINT tasks_tool_calls_check,
 DROP CONSTRAINT tasks_allocation_active_ms_check,
 ADD CHECK(root_token_limit BETWEEN 1 AND 2147483647),
 ADD CHECK(model_calls BETWEEN 0 AND 2147483647),
 ADD CHECK(tool_calls BETWEEN 0 AND 2147483647),
 ADD CHECK(allocation_active_ms BETWEEN 1 AND 2147483647),
 ADD UNIQUE(organization_id,root_task_id,id);
ALTER TABLE agents_platform.execution_roots
 DROP CONSTRAINT execution_roots_model_calls_check,
 DROP CONSTRAINT execution_roots_tool_calls_check,
 ADD CHECK(model_calls BETWEEN 0 AND 2147483647),
 ADD CHECK(tool_calls BETWEEN 0 AND 2147483647);
ALTER TABLE agents_platform.evaluation_trials DROP CONSTRAINT evaluation_trials_max_tokens_check,
 ADD CHECK(max_tokens BETWEEN 1 AND 2147483647);
ALTER TABLE agents_platform.evaluation_trial_channels DROP CONSTRAINT evaluation_trial_channels_root_token_limit_check,
 ADD CHECK(root_token_limit BETWEEN 1 AND 2147483647);

CREATE TABLE agents_platform.root_model_accounts (
 root_task_id uuid PRIMARY KEY REFERENCES agents_platform.execution_roots(root_task_id),
 organization_id uuid NOT NULL,
 currency text NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
 max_cost_micros bigint CHECK(max_cost_micros>=0),
 used_micros bigint NOT NULL DEFAULT 0 CHECK(used_micros>=0),
 reserved_micros bigint NOT NULL DEFAULT 0 CHECK(reserved_micros>=0),
 unknown_operations integer NOT NULL DEFAULT 0 CHECK(unknown_operations>=0),
 FOREIGN KEY(organization_id,root_task_id) REFERENCES agents_platform.tasks(organization_id,id),
 UNIQUE(organization_id,root_task_id)
);
CREATE TABLE agents_platform.model_cost_reservations (
 operation_id text PRIMARY KEY,
 organization_id uuid NOT NULL,
 root_task_id uuid NOT NULL,
 task_id uuid NOT NULL,
 reserved_micros bigint NOT NULL CHECK(reserved_micros>=0),
 upper_cost_micros bigint CHECK(upper_cost_micros>=0),
 state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','settled','unknown')),
 outcome text CHECK(outcome IN ('completed','failed','uncertain')),
 actual_micros bigint CHECK(actual_micros>=0),
 settlement_quote_micros bigint CHECK(settlement_quote_micros>=0),
 created_at timestamptz NOT NULL DEFAULT now(),
 settled_at timestamptz,
 FOREIGN KEY(organization_id,root_task_id) REFERENCES agents_platform.root_model_accounts(organization_id,root_task_id),
 FOREIGN KEY(organization_id,root_task_id,task_id) REFERENCES agents_platform.tasks(organization_id,root_task_id,id),
 -- Admission can reserve before inserting the operation in the same transaction.
 FOREIGN KEY(task_id,operation_id) REFERENCES agents_platform.operations(task_id,id) DEFERRABLE INITIALLY DEFERRED,
 CHECK((state='reserved' AND outcome IS NULL AND actual_micros IS NULL AND settled_at IS NULL)
    OR (state='settled' AND outcome IN ('completed','failed') AND actual_micros IS NOT NULL AND settled_at IS NOT NULL)
    OR (state='unknown' AND outcome IS NOT NULL AND settled_at IS NOT NULL)),
 CHECK(state<>'unknown' OR actual_micros IS NULL)
);
