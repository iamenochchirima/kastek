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
}) {
  const url = `https://graph.facebook.com/v19.0/${input.phoneNumberId}/messages`;

  const payload = {
    messaging_product: "whatsapp",
    to: input.recipientPhone,
    type: "text",
    text: {
      body: input.text,
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
      `WhatsApp Cloud API text send failed (${response.status}): ${errorPayload.error?.message || "Unknown error"}`
    );
  }

  const successPayload = raw as {
    messages?: Array<{ id?: string }>;
  };

  return {
    messageId: successPayload.messages?.[0]?.id || null,
    raw,
  };
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
