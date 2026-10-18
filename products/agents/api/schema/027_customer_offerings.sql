ALTER TABLE agents_platform.agents ADD COLUMN offering text CHECK(offering IN ('faq','customer-service'));
CREATE FUNCTION agents_platform.protect_agent_offering() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.offering IS DISTINCT FROM OLD.offering THEN RAISE EXCEPTION 'Agent offering is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER immutable_agent_offering BEFORE UPDATE ON agents_platform.agents
 FOR EACH ROW EXECUTE FUNCTION agents_platform.protect_agent_offering();
