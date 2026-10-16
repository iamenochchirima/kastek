UPDATE conversations
SET status = 'archived',
    archived_at = COALESCE(archived_at, now()),
    updated_at = now()
WHERE owner_actor_id IS NOT NULL
  AND status = 'active'
  AND is_primary = FALSE;
