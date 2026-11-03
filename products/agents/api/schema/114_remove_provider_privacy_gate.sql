-- Owner removed the manual provider attestation feature. Ordinary credential checks remain.
DROP FUNCTION agents_platform.fence_restored_provider_data_policies();
DROP TABLE agents_platform.model_provider_data_policy_restore_fences;
DROP TABLE agents_platform.model_provider_data_policies;
