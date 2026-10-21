ALTER TABLE agents_platform.private_model_continuations ADD COLUMN input_count jsonb
 CHECK(input_count IS NULL OR (jsonb_typeof(input_count)='object'
   AND input_count->>'precision' IN ('provider_count','provider_estimate','serialized_bytes_estimate')
   AND input_count->>'payloadDigest' ~ '^[a-f0-9]{64}$'));
