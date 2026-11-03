ALTER TABLE agents_platform.memories
  ADD COLUMN assertion_context text NOT NULL DEFAULT 'unspecified'
    CHECK (assertion_context IN ('unspecified','current','hypothetical')),
  ADD COLUMN assertion_conflict text NOT NULL DEFAULT 'not_assessed'
    CHECK (assertion_conflict IN ('not_assessed','reported','resolved'));

ALTER TABLE agents_platform.memory_revisions
  ADD COLUMN assertion_context text NOT NULL DEFAULT 'unspecified'
    CHECK (assertion_context IN ('unspecified','current','hypothetical')),
  ADD COLUMN assertion_conflict text NOT NULL DEFAULT 'not_assessed'
    CHECK (assertion_conflict IN ('not_assessed','reported','resolved')),
  ADD COLUMN assertion_origin text CHECK (assertion_origin IN ('user_supplied','model_candidate'));
