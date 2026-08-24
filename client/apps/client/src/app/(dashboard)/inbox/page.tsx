import InboxPageClient from "@/components/dashboard/inbox-page";
import type { WorkspaceConnection } from "@/lib/connections";
import { fetchRustJson } from "@/lib/rust-server-api";
import { FeatureAnalyticsPanel, INBOX_ANALYTICS_METRICS } from "@/components/analytics/feature-analytics-panel";

type RustInboxConversation = {
  id: string;
  channel: "whatsapp" | "facebook" | "instagram";
  customerName: string | null;
  phone: string;
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

type RustSocialChannel = {
  id: string;
  platform: string;
  status: string;
  display_name: string;
  handle: string | null;
};

export default async function InboxPage() {
  const [
    connectionsPayload,
    sharedConnectionsPayload,
    conversationsPayload,
    socialChannelsPayload,
  ] = await Promise.all([
    fetchRustJson<{ connections: RustConnection[] }>("/api/whatsapp/connections").catch(
      () => ({ connections: [] }),
    ),
    fetchRustJson<{ connections: WorkspaceConnection[] }>("/api/connections").catch(
      () => ({ connections: [] }),
    ),
    fetchRustJson<{ conversations: RustInboxConversation[] }>("/api/inbox/conversations").catch(
      () => ({ conversations: [] }),
    ),
    fetchRustJson<{ channels: RustSocialChannel[] }>("/api/social/channels").catch(
      () => ({ channels: [] }),
    ),
  ]);

  const connections = connectionsPayload.connections || [];
  const conversations = conversationsPayload.conversations || [];
  const socialChannels = socialChannelsPayload.channels || [];
  const providerCounts = (provider: "WHATSAPP" | "FACEBOOK" | "INSTAGRAM") => {
    const providerConnections = sharedConnectionsPayload.connections.filter(
      (connection) => connection.provider === provider && connection.consumers.includes("inbox"),
    );
    const channel = provider.toLowerCase();
    const channelConversations = conversations.filter((conversation) => conversation.channel === channel);
    return {
      connected: providerConnections.some((connection) => connection.status === "CONNECTED"),
      connectionCount: providerConnections.filter((connection) => connection.status === "CONNECTED").length,
      unreadCount: channelConversations.reduce(
        (sum, conversation) => sum + Math.max(conversation.unreadCount, 0),
        0,
      ),
      conversationCount: channelConversations.length,
    };
  };

  return (
    <>
      <div className="px-4 pt-4 sm:px-6">
        <div className="mx-auto max-w-[1440px]">
          <FeatureAnalyticsPanel title="Inbox" description="Conversation and response reporting." metricKeys={INBOX_ANALYTICS_METRICS} />
        </div>
      </div>
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
          channel: conversation.channel,
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
          whatsapp: providerCounts("WHATSAPP"),
          instagram: providerCounts("INSTAGRAM"),
          facebook: providerCounts("FACEBOOK"),
        }}
        metaConnections={{
          instagram: socialChannels
            .filter(
              (channel) => channel.platform === "INSTAGRAM" && channel.status === "CONNECTED",
            )
            .map((channel) => ({
              id: channel.id,
              label: channel.display_name,
              handle: channel.handle,
            })),
          facebook: socialChannels
            .filter(
              (channel) => channel.platform === "FACEBOOK" && channel.status === "CONNECTED",
            )
            .map((channel) => ({
              id: channel.id,
              label: channel.display_name,
              handle: channel.handle,
            })),
        }}
      />
    </>
  );
}
