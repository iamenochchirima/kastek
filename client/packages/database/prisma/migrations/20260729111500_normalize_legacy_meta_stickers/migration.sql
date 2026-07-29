-- Meta Graph identifies many sticker assets by a `sticker_` attachment id.
-- Normalize records created before the canonical sticker parser was introduced.
UPDATE "MessageAttachment"
SET kind = 'sticker'
WHERE kind = 'image'
  AND "providerMediaId" LIKE 'sticker_%';
