import { fetchFromCore } from "@/lib/admin-auth";
import { notFound } from "next/navigation";
import Link from "next/link";
import { StatusBadge } from "@/components/admin/status-badge";

interface Message {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  timestamp: string;
}

interface ConversationDetail {
  id: string;
  channel: string;
  customerIdentifier: string;
  customerName: string | null;
  status: string;
  lastMessageAt: string;
  createdAt: string;
}

export default async function ConversationDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const res = await fetchFromCore(`/api/admin/conversations/${id}`);
  if (!res.ok) notFound();

  const { conversation, messages }: { conversation: ConversationDetail; messages: Message[] } =
    await res.json();

  return (
    <div className="admin-page mx-auto max-w-3xl">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link
            href="/conversations"
            className="mb-1 inline-block text-sm text-muted-foreground hover:text-foreground"
          >
            &larr; Back to Conversations
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold tracking-[-0.02em] text-foreground">
              {conversation.customerName ?? conversation.customerIdentifier}
            </h1>
            <StatusBadge value={conversation.channel} className="text-[10px] uppercase" />
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {conversation.customerIdentifier}
            {conversation.customerName ? ` · ${conversation.customerIdentifier}` : ""}
            {" · "}
            Started {new Date(conversation.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>

      {/* Messages */}
      <div className="v-card min-h-[400px] max-h-[600px] space-y-3 overflow-y-auto p-[var(--density-card-padding)]">
        {messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No messages</p>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-start" : "justify-end"}`}
            >
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-2.5 ${
                  msg.role === "user"
                    ? "rounded-bl-sm bg-secondary text-foreground"
                    : "rounded-br-sm bg-primary/15 text-foreground"
                }`}
              >
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                <p
                  className={`text-[10px] mt-1 ${
                    msg.role === "user" ? "text-muted-foreground" : "text-primary"
                  }`}
                >
                  {msg.role === "assistant" ? "Bot · " : ""}
                  {new Date(msg.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
