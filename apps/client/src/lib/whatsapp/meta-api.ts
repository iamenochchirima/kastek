import type { SendMarketingTemplateInput, SendMarketingTemplateResult } from "./types";

function buildTemplateComponents(bodyParameters?: string[]) {
  if (!bodyParameters?.length) return undefined;

  return [
    {
      type: "body",
      parameters: bodyParameters.map((text) => ({
        type: "text",
        text,
      })),
    },
  ];
}

export async function sendMarketingTemplate(
  input: SendMarketingTemplateInput
): Promise<SendMarketingTemplateResult> {
  const url = `https://graph.facebook.com/v19.0/${input.phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: input.recipientPhone,
    type: "template",
    template: {
      name: input.templateName,
      language: {
        code: input.language,
      },
      components: buildTemplateComponents(input.bodyParameters),
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.json();

  if (!response.ok) {
    const errorPayload = raw as {
      error?: { message?: string; code?: number };
    };

    throw new Error(
      `WhatsApp Cloud API send failed (${response.status}): ${errorPayload.error?.message || "Unknown error"}`
    );
  }

  const successPayload = raw as {
    messages?: Array<{ id?: string }>;
  };

  const messageId = successPayload.messages?.[0]?.id;
  if (!messageId) {
    throw new Error("WhatsApp Cloud API did not return a message id");
  }

  return {
    messageId,
    raw,
  };
}

export async function sendTextMessage(input: {
  phoneNumberId: string;
  accessToken: string;
  recipientPhone: string;
  text: string;
  contextMessageId?: string;
}) {
  const url = `https://graph.facebook.com/v19.0/${input.phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: input.recipientPhone,
    type: "text",
    text: {
      body: input.text,
    },
    context: input.contextMessageId
      ? {
          message_id: input.contextMessageId,
        }
      : undefined,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.json();

  if (!response.ok) {
    const errorPayload = raw as {
      error?: { message?: string };
    };

    throw new Error(
      `WhatsApp Cloud API text send failed (${response.status}): ${errorPayload.error?.message || "Unknown error"}`
    );
  }

  const successPayload = raw as {
    messages?: Array<{ id?: string }>;
  };

  const messageId = successPayload.messages?.[0]?.id;
  if (!messageId) {
    throw new Error("WhatsApp Cloud API text send did not return a message id");
  }

  return {
    messageId,
    raw,
  };
}

export async function uploadWhatsappMedia(input: {
  phoneNumberId: string;
  accessToken: string;
  bytes: Uint8Array;
  filename: string;
  mimeType: string;
}) {
  const url = `https://graph.facebook.com/v19.0/${input.phoneNumberId}/media`;

  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", input.mimeType);
  form.append(
    "file",
    new Blob([input.bytes], { type: input.mimeType }),
    input.filename
  );

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
    },
    body: form,
  });

  const raw = await response.json();
  if (!response.ok) {
    const errorPayload = raw as { error?: { message?: string } };
    throw new Error(
      `WhatsApp media upload failed (${response.status}): ${errorPayload.error?.message || "Unknown error"}`
    );
  }

  const payload = raw as { id?: string };
  if (!payload.id) {
    throw new Error("WhatsApp media upload did not return a media id");
  }

  return {
    mediaId: payload.id,
    raw,
  };
}

export async function sendMediaMessage(input: {
  phoneNumberId: string;
  accessToken: string;
  recipientPhone: string;
  kind: "image" | "video" | "audio" | "document";
  mediaId: string;
  caption?: string;
  filename?: string;
  contextMessageId?: string;
}) {
  const url = `https://graph.facebook.com/v19.0/${input.phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: input.recipientPhone,
    type: input.kind,
    [input.kind]: {
      id: input.mediaId,
      caption: input.caption || undefined,
      filename: input.kind === "document" ? input.filename || undefined : undefined,
    },
    context: input.contextMessageId
      ? {
          message_id: input.contextMessageId,
        }
      : undefined,
  } as Record<string, unknown>;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.json();
  if (!response.ok) {
    const errorPayload = raw as { error?: { message?: string } };
    throw new Error(
      `WhatsApp media send failed (${response.status}): ${errorPayload.error?.message || "Unknown error"}`
    );
  }

  const successPayload = raw as {
    messages?: Array<{ id?: string }>;
  };

  const messageId = successPayload.messages?.[0]?.id;
  if (!messageId) {
    throw new Error("WhatsApp Cloud API media send did not return a message id");
  }

  return {
    messageId,
    raw,
  };
}

export async function sendReactionMessage(input: {
  phoneNumberId: string;
  accessToken: string;
  recipientPhone: string;
  messageId: string;
  emoji: string;
}) {
  const url = `https://graph.facebook.com/v19.0/${input.phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: input.recipientPhone,
    type: "reaction",
    reaction: {
      message_id: input.messageId,
      emoji: input.emoji,
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.json();

  if (!response.ok) {
    const errorPayload = raw as {
      error?: { message?: string };
    };

    throw new Error(
      `WhatsApp reaction send failed (${response.status}): ${errorPayload.error?.message || "Unknown error"}`
    );
  }

  return raw;
}

export async function markWhatsappMessageAsRead(input: {
  phoneNumberId: string;
  accessToken: string;
  messageId: string;
}) {
  const url = `https://graph.facebook.com/v19.0/${input.phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    status: "read",
    message_id: input.messageId,
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${input.accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  const raw = await response.json();

  if (!response.ok) {
    const errorPayload = raw as {
      error?: { message?: string };
    };

    throw new Error(
      `WhatsApp mark-as-read failed (${response.status}): ${errorPayload.error?.message || "Unknown error"}`
    );
  }

  return raw;
}

export async function getWhatsappMediaMetadata(input: {
  mediaId: string;
  accessToken: string;
}) {
  const url = `https://graph.facebook.com/v19.0/${input.mediaId}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
    },
  });

  const raw = await response.json();

  if (!response.ok) {
    const errorPayload = raw as {
      error?: { message?: string };
    };

    throw new Error(
      `WhatsApp media lookup failed (${response.status}): ${errorPayload.error?.message || "Unknown error"}`
    );
  }

  const payload = raw as {
    id?: string;
    url?: string;
    mime_type?: string;
  };

  if (!payload.url) {
    throw new Error("WhatsApp media lookup did not return a download URL");
  }

  return {
    id: payload.id || input.mediaId,
    url: payload.url,
    mimeType: payload.mime_type || null,
  };
}

export async function downloadWhatsappMedia(input: {
  mediaId: string;
  accessToken: string;
}) {
  const metadata = await getWhatsappMediaMetadata({
    mediaId: input.mediaId,
    accessToken: input.accessToken,
  });

  const response = await fetch(metadata.url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${input.accessToken}`,
    },
  });

  if (!response.ok) {
    const raw = await response.text().catch(() => "");
    throw new Error(
      `WhatsApp media download failed (${response.status}): ${raw || "Unknown error"}`
    );
  }

  const contentType =
    response.headers.get("content-type") || metadata.mimeType || "application/octet-stream";
  const arrayBuffer = await response.arrayBuffer();

  return {
    bytes: new Uint8Array(arrayBuffer),
    contentType,
  };
}
