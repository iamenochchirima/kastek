import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { parseWhatsappConversationIdentifier } from "@/lib/whatsapp/inbox";
import { getWhatsappAvatarInitials, getWhatsappAvatarStyles } from "@/lib/whatsapp/avatar";
import LiveWhatsappConversation from "@/components/dashboard/inbox/live-whatsapp-conversation";
import LiveWhatsappConversationList from "@/components/dashboard/inbox/live-whatsapp-conversation-list";

export default async function WhatsappInboxConversationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;

  const connections = await prisma.whatsappConnection.findMany({
    where: { userId: session.user.id },
    select: { id: true, phoneDisplayNumber: true, phoneNumberId: true },
  });

  const conversation = await prisma.conversation.findFirst({
    where: {
      id,
      channel: "whatsapp",
      OR: connections.map((connection) => ({
        customerIdentifier: {
          startsWith: `wa:${connection.id}:`,
        },
      })),
    },
    include: {
      messages: {
        orderBy: { timestamp: "asc" },
      },
    },
  });

  if (!conversation) notFound();

  const conversations = await prisma.conversation.findMany({
    where: {
      channel: "whatsapp",
      OR: connections.map((connection) => ({
        customerIdentifier: {
          startsWith: `wa:${connection.id}:`,
        },
      })),
    },
    orderBy: { lastMessageAt: "desc" },
    include: {
      messages: {
        orderBy: { timestamp: "desc" },
        take: 1,
      },
    },
  });

  const parsed = parseWhatsappConversationIdentifier(conversation.customerIdentifier);
  const connection = connections.find((item) => item.id === parsed?.connectionId);
  const avatarInitials = getWhatsappAvatarInitials({
    name: conversation.customerName,
    phone: parsed?.phone,
  });
  const avatarStyles = getWhatsappAvatarStyles({
    name: conversation.customerName,
    phone: parsed?.phone,
  });

  return (
    <div className="space-y-4 lg:h-[calc(100vh-5.5rem)] lg:overflow-hidden">
      <Link
        href="/dashboard/inbox/whatsapp"
        className="inline-flex items-center gap-1 text-sm text-text-muted no-underline hover:text-text lg:hidden"
      >
        ← Back to WhatsApp Inbox
      </Link>

      <div className="grid gap-4 lg:h-full lg:min-h-0 lg:grid-cols-[360px_minmax(0,1fr)] xl:grid-cols-[400px_minmax(0,1fr)]">
        <div className="hidden min-h-0 lg:block">
          <LiveWhatsappConversationList
            initialConversations={conversations.map((item) => {
              const lastMessage = item.messages[0];
              const itemParsed = parseWhatsappConversationIdentifier(item.customerIdentifier);

              return {
                id: item.id,
                customerName: item.customerName,
                phone: itemParsed?.phone || item.customerIdentifier,
                lastMessageAt: item.lastMessageAt.toISOString(),
                unreadCount: item.unreadCount,
                lastMessage: lastMessage
                  ? {
                      sender: lastMessage.sender as "customer" | "bot",
                      content: lastMessage.content,
                    }
                  : null,
              };
            })}
            selectedConversationId={conversation.id}
            className="h-full"
            showTopChrome
          />
        </div>

        <div className="flex min-h-0 flex-col gap-4">
          <div className="flex items-center gap-3">
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full border text-base font-semibold uppercase"
              style={avatarStyles}
            >
              {avatarInitials}
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-text">
                {conversation.customerName || parsed?.phone || "Unknown contact"}
              </h1>
              <p className="mt-1 text-sm text-text-muted">
                {parsed?.phone || conversation.customerIdentifier}
                {connection ? ` · via ${connection.phoneDisplayNumber || connection.phoneNumberId}` : ""}
              </p>
            </div>
          </div>

          <div className="min-h-0 flex-1">
            <LiveWhatsappConversation
              conversationId={conversation.id}
              initialMessages={conversation.messages.map((message) => ({
                id: message.id,
                sender: message.sender as "customer" | "bot",
                content: message.content,
                timestamp: message.timestamp.toISOString(),
                status:
                  (message.whatsappStatus as
                    | "SENT"
                    | "DELIVERED"
                    | "READ"
                    | "BLOCKED"
                    | null) || undefined,
              }))}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
