ALTER TABLE agents_platform.evaluation_trials
 DROP CONSTRAINT evaluation_trials_max_tokens_check,
 ADD CHECK(max_tokens BETWEEN 1 AND 2147483647),
 ADD COLUMN model_routes jsonb NOT NULL CHECK(jsonb_typeof(model_routes)='object'),
 ADD COLUMN model_routes_digest text NOT NULL CHECK(model_routes_digest ~ '^[a-f0-9]{64}$'),
 ADD COLUMN root_token_limit integer NOT NULL CHECK(root_token_limit>0 AND root_token_limit<=max_tokens);

CREATE FUNCTION agents_platform.protect_trial_model_routes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.model_routes IS DISTINCT FROM OLD.model_routes OR NEW.model_routes_digest IS DISTINCT FROM OLD.model_routes_digest
   OR NEW.root_token_limit IS DISTINCT FROM OLD.root_token_limit OR NEW.max_tokens IS DISTINCT FROM OLD.max_tokens
   OR NEW.organization_id IS DISTINCT FROM OLD.organization_id OR NEW.account_id IS DISTINCT FROM OLD.account_id
   OR NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.version_id IS DISTINCT FROM OLD.version_id
 THEN RAISE EXCEPTION 'Evaluation model and allocation scope is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER immutable_trial_model_routes BEFORE UPDATE ON agents_platform.evaluation_trials
 FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_trial_model_routes();

ALTER TABLE agents_platform.evaluation_trial_channels DROP CONSTRAINT evaluation_trial_channels_root_token_limit_check,
 ADD CHECK(root_token_limit BETWEEN 1 AND 2147483647);
