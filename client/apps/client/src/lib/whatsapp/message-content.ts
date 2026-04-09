export type WhatsappMediaKind = "image" | "video" | "audio" | "document" | "sticker";

export type StoredWhatsappMedia = {
  version: 1;
  kind: WhatsappMediaKind;
  mediaId: string;
  mimeType?: string | null;
  caption?: string | null;
  filename?: string | null;
  sha256?: string | null;
};

const MEDIA_PREFIX = "__kasiai_wa_media_v1__:";
const REPLY_PREFIX = "__kasiai_wa_reply_v1__:";
const REACTION_PREFIX = "__kasiai_wa_reaction_v1__:";

export type StoredWhatsappReplyEnvelope = {
  version: 1;
  replyToMessageId: string;
  replyPreview: string;
  content: string;
};

export type StoredWhatsappReaction = {
  version: 1;
  emoji: string;
  targetWhatsappMessageId?: string | null;
  targetMessageId?: string | null;
  actorIdentifier?: string | null;
};

export function encodeStoredWhatsappReplyEnvelope(envelope: StoredWhatsappReplyEnvelope) {
  return `${REPLY_PREFIX}${JSON.stringify(envelope)}`;
}

export function parseStoredWhatsappReplyEnvelope(content: string): StoredWhatsappReplyEnvelope | null {
  if (!content.startsWith(REPLY_PREFIX)) return null;

  try {
    const parsed = JSON.parse(content.slice(REPLY_PREFIX.length)) as StoredWhatsappReplyEnvelope;
    if (
      parsed?.version !== 1 ||
      !parsed?.replyToMessageId ||
      typeof parsed?.replyPreview !== "string" ||
      typeof parsed?.content !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function unwrapWhatsappStoredMessage(content: string) {
  const reply = parseStoredWhatsappReplyEnvelope(content);
  if (!reply) {
    return {
      content,
      replyPreview: null as string | null,
      replyToMessageId: null as string | null,
    };
  }

  return {
    content: reply.content,
    replyPreview: reply.replyPreview,
    replyToMessageId: reply.replyToMessageId,
  };
}

export function encodeStoredWhatsappMedia(media: StoredWhatsappMedia) {
  return `${MEDIA_PREFIX}${JSON.stringify(media)}`;
}

export function encodeStoredWhatsappReaction(reaction: StoredWhatsappReaction) {
  return `${REACTION_PREFIX}${JSON.stringify(reaction)}`;
}

export function parseStoredWhatsappMedia(content: string): StoredWhatsappMedia | null {
  const unwrapped = unwrapWhatsappStoredMessage(content);
  const resolvedContent = unwrapped.content;
  if (!resolvedContent.startsWith(MEDIA_PREFIX)) return null;

  try {
    const parsed = JSON.parse(resolvedContent.slice(MEDIA_PREFIX.length)) as StoredWhatsappMedia;
    if (
      parsed?.version !== 1 ||
      !parsed?.mediaId ||
      !["image", "video", "audio", "document", "sticker"].includes(parsed.kind)
    ) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

export function parseStoredWhatsappReaction(content: string): StoredWhatsappReaction | null {
  const unwrapped = unwrapWhatsappStoredMessage(content);
  const resolvedContent = unwrapped.content;
  if (!resolvedContent.startsWith(REACTION_PREFIX)) return null;

  try {
    const parsed = JSON.parse(resolvedContent.slice(REACTION_PREFIX.length)) as StoredWhatsappReaction;
    if (parsed?.version !== 1 || typeof parsed?.emoji !== "string") {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function getWhatsappMessageDisplayText(content: string) {
  const unwrapped = unwrapWhatsappStoredMessage(content);
  const reaction = parseStoredWhatsappReaction(unwrapped.content);
  if (reaction) {
    const emoji = reaction.emoji.trim();
    return emoji ? `Reacted ${emoji}` : "Removed reaction";
  }
  const media = parseStoredWhatsappMedia(unwrapped.content);
  if (!media) return unwrapped.content;

  const kindLabel = media.kind[0].toUpperCase() + media.kind.slice(1);
  const caption = media.caption?.trim();

  if (caption) return caption;
  return `${kindLabel} attachment`;
}

export function getWhatsappMessagePreview(content: string, maxLength = 140) {
  const text = getWhatsappMessageDisplayText(content).trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
