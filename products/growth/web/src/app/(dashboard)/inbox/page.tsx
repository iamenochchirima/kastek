import { useLoaderData } from "react-router";
import { getWorkspaceSession } from "@/lib/core-auth";
import { redirect } from "react-router";
import InboxPageClient from "@/components/dashboard/inbox-page";
import type { WorkspaceConnection } from "@/lib/connections";
import { fetchCoreJson } from "@/lib/core-server-api";

type CoreInboxConversation = {
  id: string;
  channel: "whatsapp" | "facebook" | "instagram" | "email";
  customerName: string | null;
  phone: string;
  lastMessageAt: string;
  unreadCount: number;
  starred: boolean;
  connectionId: string | null;
  connectionLabel: string | null;
  lastMessage: string;
  subject?: string | null;
  from?: string | null;
};

type CoreEmailConnection = {
  id: string;
  provider: string;
  emailAddress: string;
  displayName: string;
  status: string;
  healthStatus: string;
  syncStatus: string;
  inboxStatus: string;
  inboundStatus: string;
  outboundStatus: string;
};

type CoreWhatsappConnection = {
  id: string;
  phoneNumberId: string;
  phoneDisplayNumber: string | null;
  wabaId: string;
  currentQualityRating: string;
  dailyLimitEstimate: number | null;
  verified: boolean;
  createdAt: string;
};

type CoreSocialChannel = {
  id: string;
  platform: string;
  status: string;
  display_name: string;
  handle: string | null;
};

export async function clientLoader() {
  const session = await getWorkspaceSession();
  if (!session) throw redirect("/login");
  const [
    connectionsPayload,
    sharedConnectionsPayload,
    conversationsPayload,
    socialChannelsPayload,
    emailConnectionsPayload,
  ] = await Promise.all([
    fetchCoreJson<{ connections: CoreWhatsappConnection[] }>("/api/whatsapp/connections").catch(
      () => ({ connections: [] }),
    ),
    fetchCoreJson<{ connections: WorkspaceConnection[] }>("/api/connections").catch(
      () => ({ connections: [] }),
    ),
    fetchCoreJson<{ conversations: CoreInboxConversation[] }>("/api/inbox/conversations").catch(
      () => ({ conversations: [] }),
    ),
    fetchCoreJson<{ channels: CoreSocialChannel[] }>("/api/social/channels").catch(
      () => ({ channels: [] }),
    ),
    fetchCoreJson<{ connections: CoreEmailConnection[] }>("/api/email/connections").catch(
      () => ({ connections: [] }),
    ),
  ]);

  return { connectionsPayload, sharedConnectionsPayload, conversationsPayload, socialChannelsPayload, emailConnectionsPayload };
}

export default function InboxPage() {
  const { connectionsPayload, sharedConnectionsPayload, conversationsPayload, socialChannelsPayload, emailConnectionsPayload } = useLoaderData<typeof clientLoader>();
    const connections = connectionsPayload.connections || [];
  const conversations = conversationsPayload.conversations || [];
  const socialChannels = socialChannelsPayload.channels || [];
  const emailConnections = emailConnectionsPayload.connections || [];
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
          emailSubject: conversation.subject || undefined,
          emailFrom: conversation.from || null,
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
          email: {
            connected: emailConnections.some((connection) => connection.status === "CONNECTED" && connection.inboxStatus === "ACTIVE" && connection.inboundStatus === "READY"),
            connectionCount: emailConnections.filter((connection) => connection.status === "CONNECTED" && connection.inboxStatus === "ACTIVE").length,
            unreadCount: conversations.filter((conversation) => conversation.channel === "email").reduce((sum, conversation) => sum + Math.max(conversation.unreadCount, 0), 0),
            conversationCount: conversations.filter((conversation) => conversation.channel === "email").length,
          },
        }}
        emailConnections={emailConnections}
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
  );
}
