ALTER TABLE agents_platform.agents ADD COLUMN avatar text NOT NULL DEFAULT 'atlas'
  CHECK (avatar ~ '^[a-z0-9-]{1,40}$');

UPDATE agents_platform.agents
SET avatar = (ARRAY['atlas', 'scout', 'muse', 'orbit', 'nova', 'pixel', 'echo', 'ember', 'bolt', 'moss'])[1 + floor(random() * 10)];
