UPDATE conversations
SET title = 'New chat',
    updated_at = now()
WHERE title_source = 'fallback'
  AND lower(btrim(COALESCE(title, ''))) ~ '^(hi|hello|hey|yo|howzit|good[[:space:]]+(morning|afternoon|evening))[!,.?[:space:]]*$';
