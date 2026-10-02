import { canonicalJson, parseLosslessJson } from "@kasitek/server-support/json";
import {
  bad,
  internal,
  envInteger,
  providerRequestError,
  GRAPH_BASE,
  type ProviderOptions,
} from "./common.js";
import type { Row } from "./types.js";

async function request(
  url: string,
  init: RequestInit,
  options: ProviderOptions,
): Promise<Response> {
  try {
    return await (options.fetch ?? fetch)(url, {
      ...init,
      signal: AbortSignal.timeout(
        envInteger(options.config, "WHATSAPP_HTTP_TIMEOUT_MS", 30000, true),
      ),
    });
  } catch (error) {
    throw providerRequestError(error);
  }
}
async function decode(response: Response): Promise<Row | null> {
  try {
    return parseLosslessJson(await response.text()) as Row | null;
  } catch {
    return null;
  }
}
const statusLabel = (response: Response) =>
  `${response.status}${response.statusText ? ` ${response.statusText}` : ""}`;
function assertSuccess(
  response: Response,
  raw: Row | null,
  operation: string,
): void {
  if (!response.ok)
    throw bad(
      `${operation} (${statusLabel(response)}): ${typeof raw?.error?.message === "string" ? raw.error.message : "Unknown error"}`,
    );
}
const graph = (options: ProviderOptions) => options.graphBase ?? GRAPH_BASE;
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

async function send(
  phoneNumberId: string,
  token: string,
  payload: unknown,
  operation: string,
  options: ProviderOptions,
): Promise<Row | null> {
  const response = await request(
    `${graph(options)}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: canonicalJson(payload),
    },
    options,
  );
  const raw = await decode(response);
  assertSuccess(response, raw, operation);
  return raw;
}
function messageId(raw: Row | null, operation: string): string {
  const value = raw?.messages?.[0]?.id;
  if (typeof value !== "string")
    throw internal(`${operation} did not return a message id`);
  return value;
}

export interface WhatsappReplyButton {
  id: string;
  title: string;
}
export async function sendTextMessage(
  phoneNumberId: string,
  token: string,
  recipient: string,
  text: string,
  contextMessageId: string | null,
  options: ProviderOptions,
): Promise<{ messageId: string; raw: Row | null }> {
  const raw = await send(
    phoneNumberId,
    token,
    {
      messaging_product: "whatsapp",
      to: recipient,
      type: "text",
      text: { body: text },
      context:
        contextMessageId === null ? null : { message_id: contextMessageId },
    },
    "WhatsApp Cloud API text send failed",
    options,
  );
  return { messageId: messageId(raw, "WhatsApp Cloud API text send"), raw };
}
export async function sendReplyButtonMessage(
  phoneNumberId: string,
  token: string,
  recipient: string,
  text: string,
  buttons: readonly WhatsappReplyButton[],
  contextMessageId: string | null,
  options: ProviderOptions,
): Promise<{ messageId: string; raw: Row | null }> {
  if (!buttons.length || buttons.length > 3)
    throw bad("WhatsApp approval prompts require one to three buttons");
  if (
    buttons.some(
      (button) =>
        !button.id.trim() ||
        !button.title.trim() ||
        [...button.title].length > 20,
    )
  )
    throw bad("WhatsApp approval button labels are invalid");
  const raw = await send(
    phoneNumberId,
    token,
    {
      messaging_product: "whatsapp",
      to: recipient,
      type: "interactive",
      interactive: {
        type: "button",
        body: { text },
        action: {
          buttons: buttons.map((button) => ({
            type: "reply",
            reply: { id: button.id, title: button.title },
          })),
        },
      },
      context:
        contextMessageId === null ? null : { message_id: contextMessageId },
    },
    "WhatsApp Cloud API interactive send failed",
    options,
  );
  return {
    messageId: messageId(raw, "WhatsApp Cloud API interactive send"),
    raw,
  };
}

export async function uploadWhatsappMedia(
  phoneNumberId: string,
  token: string,
  bytes: Uint8Array,
  filename: string,
  mimeType: string | null | undefined,
  options: ProviderOptions,
): Promise<{ mediaId: string; raw: Row | null }> {
  // reqwest rejects malformed MIME values before sending the multipart body.
  const type = mimeType?.trim() ? mimeType : undefined;
  if (
    type &&
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+(?:\s*;[^\r\n]*)?$/u.test(
      type,
    )
  )
    throw bad("Attachment mime type is invalid");
  const form = new FormData();
  form.set("messaging_product", "whatsapp");
  form.set(
    "file",
    new Blob([new Uint8Array(bytes)], type ? { type } : {}),
    filename,
  );
  const response = await request(
    `${graph(options)}/${phoneNumberId}/media`,
    { method: "POST", headers: bearer(token), body: form },
    options,
  );
  const raw = await decode(response);
  assertSuccess(response, raw, "WhatsApp Cloud API media upload failed");
  if (typeof raw?.id !== "string")
    throw internal("WhatsApp media upload did not return a media id");
  return { mediaId: raw.id, raw };
}
export async function sendMediaMessage(
  phoneNumberId: string,
  token: string,
  recipient: string,
  kind: string,
  mediaId: string,
  caption: string | null,
  filename: string | null,
  contextMessageId: string | null,
  options: ProviderOptions,
): Promise<{ messageId: string; raw: Row | null }> {
  const media =
    kind === "audio"
      ? { id: mediaId }
      : ["image", "video"].includes(kind)
        ? { id: mediaId, caption }
        : { id: mediaId, caption, filename };
  const raw = await send(
    phoneNumberId,
    token,
    {
      messaging_product: "whatsapp",
      to: recipient,
      type: kind,
      [kind]: media,
      context:
        contextMessageId === null ? null : { message_id: contextMessageId },
    },
    "WhatsApp Cloud API media send failed",
    options,
  );
  return { messageId: messageId(raw, "WhatsApp Cloud API media send"), raw };
}
export async function sendMediaLinkMessage(
  phoneNumberId: string,
  token: string,
  recipient: string,
  url: string,
  caption: string | null,
  contextMessageId: string | null,
  options: ProviderOptions,
): Promise<{ messageId: string; raw: Row | null }> {
  const raw = await send(
    phoneNumberId,
    token,
    {
      messaging_product: "whatsapp",
      to: recipient,
      type: "image",
      image: { link: url, caption },
      context:
        contextMessageId === null ? null : { message_id: contextMessageId },
    },
    "WhatsApp Cloud API image send failed",
    options,
  );
  return { messageId: messageId(raw, "WhatsApp Cloud API image send"), raw };
}
export async function sendReactionMessage(
  phoneNumberId: string,
  token: string,
  recipient: string,
  targetMessageId: string,
  emoji: string,
  options: ProviderOptions,
): Promise<Row | null> {
  return send(
    phoneNumberId,
    token,
    {
      messaging_product: "whatsapp",
      to: recipient,
      type: "reaction",
      reaction: { message_id: targetMessageId, emoji },
    },
    "WhatsApp reaction send failed",
    options,
  );
}
export async function markMessageReadApi(
  phoneNumberId: string,
  token: string,
  id: string,
  options: ProviderOptions,
): Promise<void> {
  const response = await request(
    `${graph(options)}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: { ...bearer(token), "content-type": "application/json" },
      body: canonicalJson({
        messaging_product: "whatsapp",
        status: "read",
        message_id: id,
      }),
    },
    options,
  );
  if (!response.ok)
    assertSuccess(
      response,
      await decode(response),
      "WhatsApp mark-as-read failed",
    );
}
export async function getMediaMetadata(
  token: string,
  id: string,
  options: ProviderOptions,
): Promise<{ url: string; mimeType: string | null }> {
  const response = await request(
      `${graph(options)}/${id}`,
      { headers: bearer(token) },
      options,
    ),
    raw = await decode(response);
  assertSuccess(response, raw, "WhatsApp media lookup failed");
  if (typeof raw?.url !== "string")
    throw internal("WhatsApp media lookup did not return a download URL");
  return {
    url: raw.url,
    mimeType: typeof raw.mime_type === "string" ? raw.mime_type : null,
  };
}
export async function downloadMediaBytes(
  token: string,
  id: string,
  maxBytes: number | null,
  options: ProviderOptions,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const metadata = await getMediaMetadata(token, id, options);
  const response = await request(
    metadata.url,
    { headers: bearer(token) },
    options,
  );
  if (!response.ok) {
    const raw = await response.text();
    throw bad(
      `WhatsApp media download failed (${statusLabel(response)}): ${raw || "Unknown error"}`,
    );
  }
  const limitError = () => bad("WhatsApp media exceeds the allowed size");
  const length = response.headers.get("content-length");
  if (
    maxBytes !== null &&
    length !== null &&
    /^\d+$/u.test(length) &&
    BigInt(length) > BigInt(maxBytes)
  ) {
    await response.body?.cancel();
    throw limitError();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (maxBytes !== null && total > maxBytes) {
          await reader.cancel();
          throw limitError();
        }
        chunks.push(chunk.value);
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "WhatsApp media exceeds the allowed size"
      )
        throw error;
      throw providerRequestError(error);
    } finally {
      reader.releaseLock();
    }
  }
  return {
    bytes: Buffer.concat(chunks, total),
    contentType:
      response.headers.get("content-type") ??
      metadata.mimeType ??
      "application/octet-stream",
  };
}
