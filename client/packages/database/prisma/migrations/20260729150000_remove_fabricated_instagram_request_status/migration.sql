-- Meta does not expose a reliable Instagram inbox request state through the
-- webhook payloads used by KasiTek. Previous versions labelled every new
-- Instagram conversation as a request and exposed local-only Accept/Decline
-- actions. Normalize those fabricated states back to the standard inbox state.
UPDATE "Conversation"
SET status = 'active',
    "updatedAt" = NOW()
WHERE channel = 'instagram'
  AND status IN ('request', 'declined');
