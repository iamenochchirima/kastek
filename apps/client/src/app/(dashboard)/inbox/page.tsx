import InboxPageClient from "@/components/dashboard/inbox-page";
import { apiUrl } from "@/lib/server-api";
import { getRustSession } from "@/lib/rust-auth";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";

type RustInboxConversation = {
  id: string;
  customerName: string | null;
  phone: string;
  status: string;
  lastMessageAt: string;
  unreadCount: number;
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

async function fetchRustJson<T>(path: string): Promise<T> {
  const cookieStore = await cookies();
  const cookieHeader = cookieStore
    .getAll()
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");

  const response = await fetch(apiUrl(path), {
    cache: "no-store",
    headers: cookieHeader ? { Cookie: cookieHeader } : undefined,
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Rust API request failed for ${path} (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }

  return response.json() as Promise<T>;
}

export default async function InboxPage() {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const [connectionsPayload, conversationsPayload, unreadPayload] = await Promise.all([
    fetchRustJson<{ connections: RustConnection[] }>("/api/whatsapp/connections"),
    fetchRustJson<{ conversations: RustInboxConversation[] }>("/api/whatsapp/inbox/conversations"),
    fetchRustJson<{ unreadCount: number }>("/api/whatsapp/inbox/unread-count"),
  ]);

  const connections = connectionsPayload.connections || [];
  const conversations = conversationsPayload.conversations || [];

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
        starred: false,
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
          unreadCount: unreadPayload.unreadCount || 0,
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
