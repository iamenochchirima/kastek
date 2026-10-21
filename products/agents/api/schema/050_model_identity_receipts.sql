-- Requested bindings remain immutable. Reported names are evidence, not authorized replacement routes.
ALTER TABLE agents_platform.private_model_continuations
 ADD COLUMN model_identity jsonb,
 ADD COLUMN model_identity_digest text CHECK(model_identity_digest ~ '^[a-f0-9]{64}$'),
 ADD CHECK((model_identity IS NULL AND model_identity_digest IS NULL)
  OR (model_identity IS NOT NULL AND model_identity_digest IS NOT NULL
    AND jsonb_typeof(model_identity)='object'
    AND jsonb_typeof(model_identity->'requestedModelId')='string'
    AND jsonb_typeof(model_identity->'returnedModelId') IN ('string','null')
    AND model_identity->>'relation' IN ('same','different','unreported')) IS TRUE);
