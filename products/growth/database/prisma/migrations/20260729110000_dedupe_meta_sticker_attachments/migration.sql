-- Messenger can send one sticker as both an image attachment and a sticker
-- attachment in the same webhook. Keep the structured sticker representation.
DELETE FROM "MessageAttachment" image_attachment
USING "MessageAttachment" sticker_attachment
WHERE image_attachment."messageId" = sticker_attachment."messageId"
  AND image_attachment.kind = 'image'
  AND sticker_attachment.kind = 'sticker'
  AND image_attachment.metadata #>> '{providerPayload,url}' = sticker_attachment.metadata #>> '{providerPayload,url}'
  AND image_attachment.metadata #>> '{providerPayload,url}' IS NOT NULL;
