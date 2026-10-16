-- Create a non-login group role for the Agents runtime. The production connection
-- currently uses the PostgreSQL superuser, which bypasses every RLS policy. The
-- login role and password are provisioned separately by the operator so secrets do
-- not live in migration source.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kasitek_agents_runtime') THEN
    CREATE ROLE kasitek_agents_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA public TO kasitek_agents_runtime;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kasitek_agents_runtime;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO kasitek_agents_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO kasitek_agents_runtime;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kasitek_agents_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO kasitek_agents_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO kasitek_agents_runtime;
