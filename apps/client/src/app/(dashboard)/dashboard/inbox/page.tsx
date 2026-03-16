import { auth } from "@/auth";
import InboxPageClient from "@/components/dashboard/inbox-page";
import { prisma } from "@/lib/prisma";
import { parseWhatsappConversationIdentifier } from "@/lib/whatsapp/inbox";
import { getWhatsappMessagePreview } from "@/lib/whatsapp/message-content";
import { redirect } from "next/navigation";

export default async function DashboardInboxPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const connections = await prisma.whatsappConnection.findMany({
    where: { userId: session.user.id },
    select: {
      id: true,
      phoneNumberId: true,
      phoneDisplayNumber: true,
      wabaId: true,
      currentQualityRating: true,
      dailyLimitEstimate: true,
      verified: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const conversationWhere = connections.length
    ? {
        channel: "whatsapp" as const,
        OR: connections.map((connection) => ({
          customerIdentifier: {
            startsWith: `wa:${connection.id}:`,
          },
        })),
      }
    : null;

  const conversations = conversationWhere
    ? await prisma.conversation.findMany({
        where: conversationWhere,
        orderBy: { lastMessageAt: "desc" },
        take: 50,
        include: {
          messages: {
            orderBy: { timestamp: "desc" },
            take: 1,
          },
        },
      })
    : [];

  const whatsappUnreadCount = conversations.reduce(
    (total, conversation) => total + conversation.unreadCount,
    0,
  );

  const inboxConversations = conversations.map((conversation) => {
    const parsed = parseWhatsappConversationIdentifier(conversation.customerIdentifier);
    const lastMessage = conversation.messages[0];

    return {
      id: conversation.id,
      name: conversation.customerName || parsed?.phone || "Unknown contact",
      handle: parsed?.phone || conversation.customerIdentifier,
      lastMessage: lastMessage ? getWhatsappMessagePreview(lastMessage.content) : "No messages yet",
      time: conversation.lastMessageAt.toISOString(),
      unread: conversation.unreadCount > 0,
      starred: false,
      channel: "whatsapp" as const,
      avatar:
        (conversation.customerName || parsed?.phone || "?")
          .split(/\s+/)
          .filter(Boolean)
          .slice(0, 2)
          .map((part) => part[0]?.toUpperCase() || "")
          .join("")
          .slice(0, 2) || "?",
      status: "offline" as const,
      tags: [],
    };
  });

  return (
    <InboxPageClient
      whatsappConnections={connections.map((connection) => ({
        ...connection,
        createdAt: connection.createdAt.toISOString(),
      }))}
      conversations={inboxConversations}
      channelCounts={{
        whatsapp: {
          connected: connections.length > 0,
          connectionCount: connections.length,
          unreadCount: whatsappUnreadCount,
          conversationCount: conversations.length,
        },
        instagram: {
          connected: false,
          connectionCount: 0,
          unreadCount: 0,
          conversationCount: 0,
        },
        facebook: {
          connected: false,
          connectionCount: 0,
          unreadCount: 0,
          conversationCount: 0,
        },
      }}
    />
  );
}
