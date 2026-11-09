-- Reference numbers are scoped to a workspace and identify conversations, not people.
ALTER TABLE agents_platform.customer_conversations ADD COLUMN reference_number bigint;
WITH numbered AS (
  SELECT id, row_number() OVER (PARTITION BY organization_id ORDER BY created_at, id) AS reference_number
  FROM agents_platform.customer_conversations
)
UPDATE agents_platform.customer_conversations AS c SET reference_number = numbered.reference_number
FROM numbered WHERE numbered.id = c.id;

CREATE TABLE agents_platform.customer_conversation_counters (
  organization_id uuid PRIMARY KEY REFERENCES agents_platform.organizations(id) ON DELETE CASCADE,
  last_number bigint NOT NULL CHECK (last_number > 0)
);
INSERT INTO agents_platform.customer_conversation_counters (organization_id, last_number)
SELECT organization_id, max(reference_number) FROM agents_platform.customer_conversations GROUP BY organization_id;

ALTER TABLE agents_platform.customer_conversations ALTER COLUMN reference_number SET NOT NULL;
ALTER TABLE agents_platform.customer_conversations ADD CONSTRAINT customer_conversation_reference_unique UNIQUE (organization_id, reference_number);
CREATE FUNCTION agents_platform.assign_customer_conversation_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reference_number IS NOT NULL THEN
    RAISE EXCEPTION 'Conversation references are assigned by the platform';
  END IF;
  INSERT INTO agents_platform.customer_conversation_counters(organization_id, last_number)
    VALUES (NEW.organization_id, 1)
    ON CONFLICT (organization_id) DO UPDATE SET last_number=agents_platform.customer_conversation_counters.last_number+1
    RETURNING last_number INTO NEW.reference_number;
  RETURN NEW;
END;
$$;
CREATE TRIGGER assign_customer_conversation_reference BEFORE INSERT ON agents_platform.customer_conversations
  FOR EACH ROW EXECUTE FUNCTION agents_platform.assign_customer_conversation_reference();
CREATE FUNCTION agents_platform.protect_customer_conversation_reference() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.reference_number IS DISTINCT FROM OLD.reference_number THEN
    RAISE EXCEPTION 'Conversation references cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER protect_customer_conversation_reference BEFORE UPDATE ON agents_platform.customer_conversations
  FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_customer_conversation_reference();
