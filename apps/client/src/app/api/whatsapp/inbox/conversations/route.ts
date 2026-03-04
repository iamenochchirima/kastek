import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { decryptSecret } from "@/lib/whatsapp/crypto";
import { findOrCreateWhatsappConversation } from "@/lib/whatsapp/inbox";
import { sendMarketingTemplate } from "@/lib/whatsapp/meta-api";
import { normalizeToE164 } from "@/lib/whatsapp/phone";

export const runtime = "nodejs";

function renderTemplateBody(templateBody: string | null, parameters: string[]) {
  if (!templateBody) {
    return "Template message sent.";
  }

  return templateBody.replace(/{{(\d+)}}/g, (_, token) => {
    const index = Number(token) - 1;
    return parameters[index] || `[${token}]`;
  });
}

export async function POST(req: Request) {
  try {
    const session = await auth();
    const userId = session?.user?.id;

    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await req.json()) as {
      connectionId?: string;
      templateId?: string;
      phone?: string;
      customerName?: string;
      bodyParameters?: string[];
    };

    const connectionId = body.connectionId || "";
    const templateId = body.templateId || "";
    const normalizedPhone = normalizeToE164(body.phone || "");
    const customerName = body.customerName?.trim() || null;
    const bodyParameters = (body.bodyParameters || []).map((value) => value.trim());

    if (!connectionId || !templateId || !normalizedPhone) {
      return NextResponse.json(
        { error: "Connection, template, and recipient phone are required" },
        { status: 400 }
      );
    }

    const [connection, template] = await Promise.all([
      prisma.whatsappConnection.findFirst({
        where: {
          id: connectionId,
          userId,
        },
        select: {
          id: true,
          phoneNumberId: true,
          accessTokenEncrypted: true,
        },
      }),
      prisma.whatsappTemplate.findFirst({
        where: {
          id: templateId,
          userId,
          status: "APPROVED",
        },
        select: {
          id: true,
          connectionId: true,
          templateName: true,
          language: true,
          body: true,
          variablesCount: true,
          category: true,
        },
      }),
    ]);

    if (!connection) {
      return NextResponse.json({ error: "WhatsApp connection not found" }, { status: 404 });
    }

    if (!template) {
      return NextResponse.json({ error: "Approved template not found" }, { status: 404 });
    }

    if (template.connectionId && template.connectionId !== connection.id) {
      return NextResponse.json(
        { error: "Selected template does not belong to this WhatsApp connection" },
        { status: 400 }
      );
    }

    if (bodyParameters.length !== template.variablesCount) {
      return NextResponse.json(
        {
          error: `This template expects ${template.variablesCount} variable${template.variablesCount === 1 ? "" : "s"}.`,
        },
        { status: 400 }
      );
    }

    const accessToken = decryptSecret(connection.accessTokenEncrypted);
    const sendResult = await sendMarketingTemplate({
      phoneNumberId: connection.phoneNumberId,
      accessToken,
      recipientPhone: normalizedPhone,
      templateName: template.templateName,
      language: template.language,
      bodyParameters,
    });

    const conversation = await findOrCreateWhatsappConversation({
      connectionId: connection.id,
      phone: normalizedPhone,
      customerName,
    });

    await prisma.$transaction(async (tx) => {
      await tx.whatsappContact.upsert({
        where: {
          userId_phone: {
            userId,
            phone: normalizedPhone,
          },
        },
        update: {
          fullName: customerName || undefined,
        },
        create: {
          userId,
          phone: normalizedPhone,
          fullName: customerName,
          optIn: false,
          excluded: false,
        },
      });

      await tx.message.create({
        data: {
          conversationId: conversation.id,
          sender: "bot",
          content: renderTemplateBody(template.body, bodyParameters),
        },
      });

      await tx.conversation.update({
        where: { id: conversation.id },
        data: {
          lastMessageAt: new Date(),
          status: "active",
          customerName,
        },
      });
    });

    return NextResponse.json({
      success: true,
      conversationId: conversation.id,
      messageId: sendResult.messageId,
      category: template.category,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Failed to start WhatsApp conversation";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
