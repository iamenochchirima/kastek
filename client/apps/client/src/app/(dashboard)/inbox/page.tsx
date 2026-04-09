import InboxPageClient from "@/components/dashboard/inbox-page";
import { fetchRustJson } from "@/lib/rust-server-api";

type RustInboxConversation = {
  id: string;
  customerName: string | null;
  phone: string;
  status: string;
  lastMessageAt: string;
  unreadCount: number;
  starred: boolean;
  connectionId: string | null;
  connectionLabel: string | null;
  lastMessage: string;
};

type RustConnection = {
  id: string;
  phoneNumberId: string;
  phoneDisplayNumber: string | null;
  wabaId: string;
  currentQualityRating: string;
  dailyLimitEstimate: number | null;
  verified: boolean;
  createdAt: string;
};

export default async function InboxPage() {
  const [connectionsPayload, conversationsPayload] = await Promise.all([
    fetchRustJson<{ connections: RustConnection[] }>("/api/whatsapp/connections"),
    fetchRustJson<{ conversations: RustInboxConversation[] }>("/api/whatsapp/inbox/conversations"),
  ]);

  const connections = connectionsPayload.connections || [];
  const conversations = conversationsPayload.conversations || [];
  const unreadCount = conversations.reduce((sum, conversation) => sum + Math.max(conversation.unreadCount, 0), 0);

  return (
    <InboxPageClient
      whatsappConnections={connections}
      conversations={conversations.map((conversation) => ({
        id: conversation.id,
        name: conversation.customerName || conversation.phone || "Unknown contact",
        handle: conversation.phone,
        lastMessage: conversation.lastMessage || "No messages yet",
        time: conversation.lastMessageAt,
        unread: conversation.unreadCount > 0,
        starred: conversation.starred,
        channel: "whatsapp" as const,
        connectionId: conversation.connectionId,
        connectionLabel: conversation.connectionLabel || conversation.phone || "Unknown number",
        avatar:
          (conversation.customerName || conversation.phone || "?")
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => part[0]?.toUpperCase() || "")
            .join("")
            .slice(0, 2) || "?",
        status: "offline" as const,
        tags: [],
      }))}
      channelCounts={{
        whatsapp: {
          connected: connections.length > 0,
          connectionCount: connections.length,
          unreadCount,
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
