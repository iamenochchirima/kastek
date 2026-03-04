import { NextResponse } from "next/server";
import { prisma } from "@kasitek/database";

const API_KEY = process.env.CONVERSATIONS_API_KEY || "kasitek-conversations-secret";

export async function POST(req: Request) {
  const apiKey = req.headers.get("x-api-key");
  if (apiKey !== API_KEY) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await req.json();
  const { channel, customerIdentifier, customerName, customerMessage, botResponse } = body;

  if (!channel || !customerIdentifier || !customerMessage) {
    return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
  }

  // Find or create conversation
  let conversation = await prisma.conversation.findUnique({
    where: { channel_customerIdentifier: { channel, customerIdentifier } },
  });

  if (!conversation) {
    conversation = await prisma.conversation.create({
      data: {
        channel,
        customerIdentifier,
        customerName: customerName || null,
        status: "active",
      },
    });
  } else if (customerName && !conversation.customerName) {
    conversation = await prisma.conversation.update({
      where: { id: conversation.id },
      data: { customerName },
    });
  }

  // Create messages
  const messages = [
    {
      conversationId: conversation.id,
      sender: "customer",
      content: customerMessage,
    },
  ];

  if (botResponse) {
    messages.push({
      conversationId: conversation.id,
      sender: "bot",
      content: botResponse,
    });
  }

  await prisma.message.createMany({ data: messages });

  // Update lastMessageAt
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });

  return NextResponse.json({ success: true, conversationId: conversation.id }, { status: 201 });
}
