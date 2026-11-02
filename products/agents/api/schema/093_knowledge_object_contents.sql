CREATE TABLE agents_platform.knowledge_object_contents (
  object_key text PRIMARY KEY CHECK (object_key ~ '^(knowledge|knowledge-query)/[a-zA-Z0-9/_-]+$' AND length(object_key) <= 512),
  content bytea NOT NULL CHECK (octet_length(content) <= 10485760),
  content_type text NOT NULL CHECK (length(content_type) BETWEEN 1 AND 255),
  created_at timestamptz NOT NULL DEFAULT now()
);
