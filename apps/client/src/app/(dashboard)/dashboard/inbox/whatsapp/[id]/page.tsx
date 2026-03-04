import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { parseWhatsappConversationIdentifier } from "@/lib/whatsapp/inbox";
import LiveWhatsappConversation from "@/components/dashboard/inbox/live-whatsapp-conversation";

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

  const parsed = parseWhatsappConversationIdentifier(conversation.customerIdentifier);
  const connection = connections.find((item) => item.id === parsed?.connectionId);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div>
        <Link
          href="/dashboard/inbox/whatsapp"
          className="mb-2 inline-flex items-center gap-1 text-sm text-text-muted no-underline hover:text-text"
        >
          ← Back to WhatsApp Inbox
        </Link>
        <h1 className="text-2xl font-semibold text-text">
          {conversation.customerName || parsed?.phone || "Unknown contact"}
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          {parsed?.phone || conversation.customerIdentifier}
          {connection ? ` · via ${connection.phoneDisplayNumber || connection.phoneNumberId}` : ""}
        </p>
      </div>

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

      <p className="text-xs text-text-dim">
        Historical messages from before the number was connected may not appear here. This inbox is
        reliable from connection time onward.
      </p>
    </div>
  );
}
