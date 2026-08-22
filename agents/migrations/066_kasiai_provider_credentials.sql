ALTER TABLE kasiai_user_preferences
  ADD COLUMN IF NOT EXISTS default_credential_reference TEXT;
