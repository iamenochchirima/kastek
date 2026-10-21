import { ChannelAdapterError, channelAttachmentSchema, type ChannelProviderContext, type ChannelSendRequest, type ChannelSendResult } from "../../../contracts/channel-adapters";

const field = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value);
function rejected(code: string): never { throw new ChannelAdapterError(code, "rejected", 400); }
function retryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value || !/^\d+$/.test(value)) return undefined;
  const milliseconds = Number(value) * 1000; return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
}

/** One call is one provider message; durable splitting, policy checks and reconciliation belong to the delivery worker. */
export async function sendMetaMessage(kind: "facebook" | "instagram", request: ChannelSendRequest, context: ChannelProviderContext): Promise<ChannelSendResult> {
  if (!context.credential?.trim() || /[\r\n]/.test(context.credential) || !context.fetch) rejected("CHANNEL_CREDENTIAL_REQUIRED");
  if (!context.apiVersion || !/^v\d+\.\d+$/.test(context.apiVersion)) rejected("CHANNEL_API_VERSION_REQUIRED");
  if (!field(request.assetId) || !field(request.recipientId) || request.replyToProviderMessageId !== undefined && !field(request.replyToProviderMessageId)) rejected("CHANNEL_SEND_INVALID");
  if (context.mode !== "meta" && context.mode !== "instagram_login" || kind === "facebook" && context.mode !== "meta") rejected("CHANNEL_AUTH_MODE_INVALID");
  const direct = context.mode === "instagram_login", senderAsset = kind === "instagram" && !direct ? context.pageId : request.assetId;
  if (!field(senderAsset)) rejected("CHANNEL_PAGE_BINDING_REQUIRED");
  if (request.template) rejected("CHANNEL_TEMPLATE_UNSUPPORTED");
  const attachments = request.attachments ?? [], text = request.text;
  if (typeof text !== "string" || attachments.length > 1 || attachments.length && text.length || !attachments.length && !text.trim()) rejected("CHANNEL_SEND_COMBINATION_UNSUPPORTED");
  const message: Record<string, unknown> = {};
  if (attachments.length) {
    const parsed = channelAttachmentSchema.safeParse(attachments[0]); if (!parsed.success) rejected("CHANNEL_ATTACHMENT_INVALID");
    const attachment = parsed.data;
    if (kind === "instagram" && attachment.kind === "document") rejected("CHANNEL_ATTACHMENT_UNSUPPORTED");
    if (Boolean(attachment.url) === Boolean(attachment.providerMediaId)) rejected("CHANNEL_ATTACHMENT_SOURCE_INVALID");
    if (attachment.url) {
      const url = new URL(attachment.url); if (url.protocol !== "https:" || url.username || url.password || url.hash) rejected("CHANNEL_ATTACHMENT_URL_INVALID");
    }
    if (direct && attachment.providerMediaId) rejected("CHANNEL_ATTACHMENT_REUSE_UNSUPPORTED");
    message.attachment = { type: attachment.kind === "document" ? "file" : attachment.kind,
      payload: attachment.url ? { url: attachment.url } : { attachment_id: attachment.providerMediaId } };
  } else message.text = text;
  if (request.replyToProviderMessageId) message.reply_to = { mid: request.replyToProviderMessageId };
  const body = { recipient: { id: request.recipientId }, ...(!direct ? { messaging_type: "RESPONSE" } : {}), message };
  const destination = `https://${direct ? "graph.instagram.com" : "graph.facebook.com"}/${context.apiVersion}/${encodeURIComponent(senderAsset!)}/messages`;
  if (context.signal?.aborted) throw new ChannelAdapterError("CHANNEL_CANCELLED_BEFORE_DISPATCH", "rejected", 409);
  let response: Response;
  try { response = await context.fetch(destination, { method: "POST", redirect: "error", headers: { authorization: `Bearer ${context.credential}`, "content-type": "application/json" }, body: JSON.stringify(body), signal: context.signal }); }
  catch (error) { if (error instanceof ChannelAdapterError) throw error; throw new ChannelAdapterError("CHANNEL_SEND_OUTCOME_UNKNOWN", "unknown"); }
  let payload: unknown;
  try { payload = await response.json(); } catch { if (response.ok) throw new ChannelAdapterError("CHANNEL_RESPONSE_INVALID", "unknown", response.status); payload = {}; }
  const data = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  if (!response.ok || data.error) {
    const error = data.error && typeof data.error === "object" ? data.error as Record<string, unknown> : {};
    const code = response.status === 401 || error.code === 190 ? "CHANNEL_AUTHENTICATION_FAILED"
      : response.status === 403 || error.code === 10 || error.code === 200 ? "CHANNEL_PERMISSION_DENIED"
      : response.status === 429 || [4, 17, 32, 613].includes(Number(error.code)) ? "CHANNEL_RATE_LIMITED"
      : response.status === 404 ? "CHANNEL_ASSET_UNAVAILABLE" : "CHANNEL_PROVIDER_REJECTED";
    throw new ChannelAdapterError(code, response.status >= 500 || response.status === 408 || response.status < 400 ? "unknown" : "rejected", response.status, retryAfter(response));
  }
  if (data.recipient_id !== undefined && data.recipient_id !== request.recipientId) throw new ChannelAdapterError("CHANNEL_RESPONSE_SCOPE_MISMATCH", "unknown", response.status);
  return field(data.message_id) ? { providerMessageId: data.message_id as string, status: "accepted" } : { providerMessageId: null, status: "unknown" };
}
