ALTER TABLE agents_platform.conversations
  ADD COLUMN IF NOT EXISTS title text CHECK (title IS NULL OR (char_length(btrim(title)) BETWEEN 1 AND 120));
