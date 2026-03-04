import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { parseWhatsappConversationIdentifier } from "@/lib/whatsapp/inbox";
import ReplyBox from "@/components/dashboard/inbox/reply-box";

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

      <div className="min-h-[420px] space-y-3 rounded-xl border border-border bg-surface p-4">
        {conversation.messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-muted">No messages yet.</p>
        ) : (
          conversation.messages.map((message) => (
            <div
              key={message.id}
              className={`flex ${message.sender === "customer" ? "justify-start" : "justify-end"}`}
            >
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-2.5 ${
                  message.sender === "customer"
                    ? "rounded-bl-sm bg-surface-2 text-text"
                    : "rounded-br-sm bg-accent/20 text-text"
                }`}
              >
                <p className="whitespace-pre-wrap text-sm">{message.content}</p>
                <p className="mt-1 text-[10px] text-text-dim">
                  {message.sender === "bot" ? "You · " : ""}
                  {message.timestamp.toLocaleTimeString("en-ZA", {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
            </div>
          ))
        )}
      </div>

      <ReplyBox conversationId={conversation.id} />

      <p className="text-xs text-text-dim">
        Historical messages from before the number was connected may not appear here. This inbox is
        reliable from connection time onward.
      </p>
    </div>
  );
}
