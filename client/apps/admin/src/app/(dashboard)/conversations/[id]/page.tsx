import { fetchFromCore } from "@/lib/admin-auth";
import { notFound } from "next/navigation";
import Link from "next/link";

const CHANNEL_BADGES: Record<string, string> = {
  whatsapp: "bg-green-500/15 text-green-400",
  website: "bg-blue-500/15 text-blue-400",
};

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
    <div className="max-w-3xl mx-auto space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <Link
            href="/conversations"
            className="text-sm text-text-muted hover:text-text mb-1 inline-block"
          >
            &larr; Back to Conversations
          </Link>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-bold text-text">
              {conversation.customerName ?? conversation.customerIdentifier}
            </h1>
            <span
              className={`text-[10px] font-semibold px-2 py-0.5 rounded-full uppercase ${
                CHANNEL_BADGES[conversation.channel] ?? ""
              }`}
            >
              {conversation.channel}
            </span>
          </div>
          <p className="text-text-faint text-xs mt-0.5">
            {conversation.customerIdentifier}
            {conversation.customerName ? ` · ${conversation.customerIdentifier}` : ""}
            {" · "}
            Started {new Date(conversation.createdAt).toLocaleDateString()}
          </p>
        </div>
      </div>

      {/* Messages */}
      <div className="bg-surface-raised rounded-xl border border-border p-4 space-y-3 min-h-[400px] max-h-[600px] overflow-y-auto">
        {messages.length === 0 ? (
          <p className="text-text-faint text-sm text-center py-8">No messages</p>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex ${msg.role === "user" ? "justify-start" : "justify-end"}`}
            >
              <div
                className={`max-w-[75%] rounded-2xl px-4 py-2.5 ${
                  msg.role === "user"
                    ? "bg-surface-overlay text-text rounded-bl-sm"
                    : "bg-primary/20 text-text rounded-br-sm"
                }`}
              >
                <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                <p
                  className={`text-[10px] mt-1 ${
                    msg.role === "user" ? "text-text-faint" : "text-primary/60"
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
