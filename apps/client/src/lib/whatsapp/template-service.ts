import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/whatsapp/crypto";
import type { Prisma } from "@kasiai/database";
import {
  NotificationRecipientType,
  NotificationScopeType,
  NotificationSeverity,
  publishNotificationEvent,
} from "@kasiai/database";

const GRAPH_BASE = "https://graph.facebook.com/v19.0";

type GraphTemplate = {
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  components?: Array<{
    type?: string;
    text?: string;
    format?: string;
    buttons?: Array<Record<string, unknown>>;
  }>;
};

type GraphErrorResponse = {
  error?: {
    message?: string;
    code?: number;
    error_subcode?: number;
    fbtrace_id?: string;
    error_user_title?: string;
    error_user_msg?: string;
  };
};

export type WhatsappTemplateCategoryValue = "MARKETING" | "UTILITY" | "AUTHENTICATION";

export function toWhatsappTemplateErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : "Failed to process WhatsApp template";

  if (
    message.includes('invalid input value for enum "WhatsappTemplateCategory"') ||
    message.includes("invalid input value for enum 'WhatsappTemplateCategory'")
  ) {
    return "Your database schema is out of date for WhatsApp template categories. Run `pnpm db:push` to update the enum, then sync again.";
  }

  return message;
}

export function mapTemplateStatus(
  value?: string
): "APPROVED" | "PENDING" | "REJECTED" | "DISABLED" {
  const normalized = value?.toUpperCase();
  if (normalized === "APPROVED") return "APPROVED";
  if (normalized === "PENDING") return "PENDING";
  if (normalized === "REJECTED") return "REJECTED";
  return "DISABLED";
}

export function mapTemplateCategory(value?: string): WhatsappTemplateCategoryValue | null {
  const normalized = value?.toUpperCase();
  if (normalized === "MARKETING") return "MARKETING";
  if (normalized === "UTILITY") return "UTILITY";
  if (normalized === "AUTHENTICATION") return "AUTHENTICATION";
  return null;
}

function extractTemplateParts(template: GraphTemplate) {
  const parts = template.components || [];
  const header = parts.find((part) => part.type === "HEADER");
  const body = parts.find((part) => part.type === "BODY");
  const footer = parts.find((part) => part.type === "FOOTER");
  const buttons = parts.find((part) => part.type === "BUTTONS");

  return {
    header: header?.text || null,
    body: body?.text || null,
    footer: footer?.text || null,
    buttons: buttons?.buttons || null,
  };
}

function toJsonValue(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  return value as Prisma.InputJsonValue;
}

function inferVariablesCount(bodyText?: string | null): number {
  if (!bodyText) return 0;

  const matches = bodyText.match(/{{\d+}}/g) || [];
  return matches.length;
}

function extractVariableTokens(value?: string | null): string[] {
  if (!value) return [];

  return Array.from(new Set(value.match(/{{\d+}}/g) || [])).sort((left, right) => {
    const leftIndex = Number.parseInt(left.replace(/[{}]/g, ""), 10);
    const rightIndex = Number.parseInt(right.replace(/[{}]/g, ""), 10);
    return leftIndex - rightIndex;
  });
}

function buildComponentExample(value?: string | null, prefix = "sample") {
  const tokens = extractVariableTokens(value);
  if (tokens.length === 0) return undefined;

  return tokens.map((_, index) => `${prefix}_${index + 1}`);
}

async function fetchGraphJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json()) as T & GraphErrorResponse;

  if (!response.ok) {
    const details = [
      body.error?.message,
      body.error?.error_user_title,
      body.error?.error_user_msg,
      body.error?.code ? `code ${body.error.code}` : null,
      body.error?.error_subcode ? `subcode ${body.error.error_subcode}` : null,
      body.error?.fbtrace_id ? `trace ${body.error.fbtrace_id}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    throw new Error(
      `Graph API request failed (${response.status}): ${details || "Unknown error"}`
    );
  }

  return body;
}

export async function syncWhatsappTemplates(
  accessToken: string,
  userId: string,
  wabaId: string,
  connectionId: string
) {
  const response = await fetchGraphJson<{ data?: GraphTemplate[] }>(
    `${GRAPH_BASE}/${wabaId}/message_templates?fields=name,language,status,category,components&limit=250&access_token=${encodeURIComponent(accessToken)}`
  );

  const templates = (response.data || []).filter((template) => mapTemplateCategory(template.category));

  let synced = 0;

  for (const template of templates) {
    const templateName = template.name;
    const language = template.language;
    const category = mapTemplateCategory(template.category);
    if (!templateName || !language || !category) continue;

    const parts = extractTemplateParts(template);

    await prisma.whatsappTemplate.upsert({
      where: {
        userId_templateName_language: {
          userId,
          templateName,
          language,
        },
      },
      update: {
        connectionId,
        category,
        status: mapTemplateStatus(template.status),
        header: parts.header,
        body: parts.body,
        footer: parts.footer,
        buttons: toJsonValue(parts.buttons),
        variablesCount: inferVariablesCount(parts.body),
        lastSynced: new Date(),
      },
      create: {
        userId,
        connectionId,
        templateName,
        language,
        category,
        status: mapTemplateStatus(template.status),
        header: parts.header,
        body: parts.body,
        footer: parts.footer,
        buttons: toJsonValue(parts.buttons),
        variablesCount: inferVariablesCount(parts.body),
        lastSynced: new Date(),
      },
    });

    synced += 1;
  }

  return {
    fetched: response.data?.length || 0,
    synced,
  };
}

function normalizeTemplateName(input: string) {
  return input.trim().toLowerCase().replace(/[^a-z0-9_]+/g, "_");
}

export async function createWhatsappTemplate(input: {
  userId: string;
  connectionId: string;
  templateName: string;
  language: string;
  category: WhatsappTemplateCategoryValue;
  header?: string;
  body: string;
  footer?: string;
}) {
  const connection = await prisma.whatsappConnection.findFirst({
    where: {
      id: input.connectionId,
      userId: input.userId,
    },
    select: {
      id: true,
      userId: true,
      wabaId: true,
      accessTokenEncrypted: true,
    },
  });

  if (!connection) {
    throw new Error("WhatsApp connection not found");
  }

  const templateName = normalizeTemplateName(input.templateName);
  const language = input.language.trim();
  const category = input.category;
  const body = input.body.trim();
  const header = input.header?.trim() || "";
  const footer = input.footer?.trim() || "";
  const headerExample = buildComponentExample(header, "header");
  const bodyExample = buildComponentExample(body, "body");

  if (!templateName) {
    throw new Error("Template name is required");
  }

  if (!/^[a-z0-9_]+$/.test(templateName)) {
    throw new Error("Template name can only contain lowercase letters, numbers, and underscores");
  }

  if (!language) {
    throw new Error("Template language is required");
  }

  if (!body) {
    throw new Error("Template body is required");
  }

  const accessToken = decryptSecret(connection.accessTokenEncrypted);
  const components = [
    ...(header
      ? [
          {
            type: "HEADER",
            format: "TEXT",
            text: header,
            ...(headerExample
              ? {
                  example: {
                    header_text: headerExample,
                  },
                }
              : {}),
          },
        ]
      : []),
    {
      type: "BODY",
      text: body,
      ...(bodyExample
        ? {
            example: {
              body_text: [bodyExample],
            },
          }
        : {}),
    },
    ...(footer
      ? [
          {
            type: "FOOTER",
            text: footer,
          },
        ]
      : []),
  ];

  const response = await fetchGraphJson<{ id?: string; status?: string }>(
    `${GRAPH_BASE}/${connection.wabaId}/message_templates`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        name: templateName,
        category,
        language,
        components,
      }),
    }
  );

  const template = await prisma.whatsappTemplate.upsert({
    where: {
      userId_templateName_language: {
        userId: input.userId,
        templateName,
        language,
      },
    },
    update: {
      connectionId: connection.id,
      category,
      header: header || null,
      body,
      footer: footer || null,
      variablesCount: inferVariablesCount(body),
      status: mapTemplateStatus(response.status || "PENDING"),
      lastSynced: new Date(),
    },
    create: {
      userId: input.userId,
      connectionId: connection.id,
      templateName,
      language,
      category,
      header: header || null,
      body,
      footer: footer || null,
      variablesCount: inferVariablesCount(body),
      status: mapTemplateStatus(response.status || "PENDING"),
      lastSynced: new Date(),
    },
  });

  return {
    template,
    metaTemplateId: response.id || null,
    status: template.status,
  };
}

export async function refreshTemplateFromWebhook(input: {
  connectionPhoneNumberId?: string;
  templateName?: string;
  language?: string;
  event?: string;
  status?: string;
}) {
  const templateName = input.templateName?.trim();
  const language = input.language?.trim();
  if (!templateName || !language) return;

  const connection = input.connectionPhoneNumberId
    ? await prisma.whatsappConnection.findUnique({
        where: { phoneNumberId: input.connectionPhoneNumberId },
        select: { id: true, userId: true },
      })
    : null;

  if (!connection) return;

  const nextStatus = mapTemplateStatus(input.status || input.event);
  const existingTemplates = await prisma.whatsappTemplate.findMany({
    where: {
      userId: connection.userId,
      templateName,
      language,
    },
    select: {
      id: true,
      status: true,
    },
  });

  await prisma.whatsappTemplate.updateMany({
    where: {
      userId: connection.userId,
      templateName,
      language,
    },
    data: {
      connectionId: connection.id,
      status: nextStatus,
      lastSynced: new Date(),
    },
  });

  const changed = existingTemplates.some((template) => template.status !== nextStatus);
  if (!changed) return;

  const titles: Record<"APPROVED" | "REJECTED" | "DISABLED", string> = {
    APPROVED: "Template approved",
    REJECTED: "Template rejected",
    DISABLED: "Template disabled",
  };
  const messages: Record<"APPROVED" | "REJECTED" | "DISABLED", string> = {
    APPROVED: `Your WhatsApp template "${templateName}" was approved and is ready to use.`,
    REJECTED: `Your WhatsApp template "${templateName}" was rejected by Meta and needs review.`,
    DISABLED: `Your WhatsApp template "${templateName}" was disabled and can no longer be used.`,
  };
  const severities: Record<"APPROVED" | "REJECTED" | "DISABLED", NotificationSeverity> = {
    APPROVED: NotificationSeverity.SUCCESS,
    REJECTED: NotificationSeverity.WARNING,
    DISABLED: NotificationSeverity.CRITICAL,
  };

  if (nextStatus === "APPROVED" || nextStatus === "REJECTED" || nextStatus === "DISABLED") {
    await publishNotificationEvent({
      scopeType: NotificationScopeType.USER,
      scopeId: connection.userId,
      eventType: `template.${nextStatus.toLowerCase()}`,
      title: titles[nextStatus],
      message: messages[nextStatus],
      severity: severities[nextStatus],
      entityType: "template",
      entityId: existingTemplates[0]?.id,
      payload: {
        templateName,
        language,
        status: nextStatus,
        connectionId: connection.id,
      },
      dedupeKey: `template:${templateName}:${language}:${nextStatus}`,
      dedupeWindowMinutes: 30,
      recipients: [
        {
          recipientType: NotificationRecipientType.USER,
          recipientId: connection.userId,
        },
      ],
    });
  }
}
