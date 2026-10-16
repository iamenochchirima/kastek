export function websiteChannelMessagePayload(
  channelKey: string,
  event: string,
  identity: string,
  conversation: string,
  text: string,
  displayName?: string | null,
): Record<string, unknown> {
  return {
    channelType: "website",
    channelKey,
    provider: "kasitek-website",
    providerEventId: event,
    providerMessageId: event,
    externalIdentity: identity,
    externalConversationId: conversation,
    messageType: "text",
    content: { text },
    ...(displayName == null ? {} : { displayName }),
  };
}
export function websiteChannelAudioPayload(
  channelKey: string,
  installationId: string,
  event: string,
  identity: string,
  conversation: string,
  text: string,
  assetId: string,
  mimeType: string,
  fileName?: string | null,
  displayName?: string | null,
): Record<string, unknown> {
  return {
    channelType: "website",
    channelKey,
    installationId,
    provider: "kasitek-website",
    providerEventId: event,
    providerMessageId: event,
    externalIdentity: identity,
    externalConversationId: conversation,
    messageType: "attachment",
    content: {
      text,
      assetId,
      mimeType,
      mediaKind: "audio",
      transcription: { status: "queued", provider: "elevenlabs" },
      ...(fileName == null ? {} : { fileName }),
    },
    ...(displayName == null ? {} : { displayName }),
  };
}
