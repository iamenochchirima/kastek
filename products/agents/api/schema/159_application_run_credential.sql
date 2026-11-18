ALTER TABLE agents_platform.execution_grants ADD COLUMN application_credential_id uuid
  REFERENCES agents_platform.application_credentials(id);

-- Keep the application's identity stable while recording the key that authorized each run.
UPDATE agents_platform.execution_grants SET application_credential_id=(principal->>'credentialId')::uuid,
  principal=principal-'credentialId' WHERE principal->>'kind'='application';
UPDATE agents_platform.tasks SET principal=principal-'credentialId' WHERE principal->>'kind'='application';
UPDATE agents_platform.conversations SET principal=principal-'credentialId' WHERE principal->>'kind'='application';
