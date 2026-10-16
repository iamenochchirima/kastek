-- Make the product execution environment explicit at the installation
-- boundary. Existing installations predate Playground and are treated as
-- live; new Playground installations must opt in with environment=playground.
UPDATE agent_installations
SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{environment}', '"live"'::jsonb, true),
    updated_at = now()
WHERE COALESCE(settings ->> 'environment', '') = '';

ALTER TABLE agent_installations
  ALTER COLUMN settings SET DEFAULT '{}'::jsonb;
