import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import { parseWhatsappConversationIdentifier } from "@/lib/whatsapp/inbox";
import { getWhatsappConnectionStats } from "@/lib/whatsapp/connection-stats";
import WhatsappManualConnectionCard from "@/components/dashboard/settings/whatsapp-manual-connection-card";
import InboxRefreshButton from "@/components/dashboard/inbox/inbox-refresh-button";
import NewWhatsappConversationCard from "@/components/dashboard/inbox/new-whatsapp-conversation-card";
import LiveWhatsappConversationList from "@/components/dashboard/inbox/live-whatsapp-conversation-list";

export const metadata = {
  title: "WhatsApp Inbox | KasiAI",
};

export default async function WhatsappInboxPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;
  const query = params.q?.trim() || "";

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

  const statsByConnection = await getWhatsappConnectionStats(connections.map((connection) => connection.id));
  const templates = await prisma.whatsappTemplate.findMany({
    where: {
      userId: session.user.id,
    },
    select: {
      id: true,
      connectionId: true,
      templateName: true,
      language: true,
      category: true,
      status: true,
      variablesCount: true,
      body: true,
    },
    orderBy: { updatedAt: "desc" },
  });

  if (!connections.length) {
    return (
      <div className="space-y-6">
        <div>
          <Link
            href="/dashboard/inbox"
            className="mb-2 inline-flex items-center gap-1 text-sm text-text-muted no-underline hover:text-text"
          >
            ← Back to Inbox
          </Link>
          <h1 className="mb-2 text-3xl font-semibold tracking-tight">WhatsApp Inbox</h1>
          <p className="text-text-muted">
            Connect your WhatsApp Cloud API number to start receiving conversations here.
          </p>
        </div>

        <WhatsappManualConnectionCard connections={[]} mode="setup" />
      </div>
    );
  }

  const conversationWhere = {
    channel: "whatsapp",
    OR: connections.map((connection) => ({
      customerIdentifier: {
        startsWith: `wa:${connection.id}:`,
      },
    })),
    ...(query
      ? {
          AND: [
            {
              OR: [
                { customerName: { contains: query, mode: "insensitive" as const } },
                { customerIdentifier: { contains: query } },
              ],
            },
          ],
        }
      : {}),
  };

  const conversations = await prisma.conversation.findMany({
    where: conversationWhere,
    orderBy: { lastMessageAt: "desc" },
    include: {
      messages: {
        orderBy: { timestamp: "desc" },
        take: 1,
      },
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <Link
            href="/dashboard/inbox"
            className="mb-2 inline-flex items-center gap-1 text-sm text-text-muted no-underline hover:text-text"
          >
            ← Back to Inbox
          </Link>
          <h1 className="mb-2 text-3xl font-semibold tracking-tight">WhatsApp Inbox</h1>
          <p className="text-text-muted">
            View WhatsApp conversations captured after your number was connected to KasiAI.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <InboxRefreshButton />
          <Link
            href="/dashboard/campaigns/whatsapp"
            className="rounded-lg border border-border px-4 py-2 text-sm text-text no-underline hover:border-border-light"
          >
            Go to WhatsApp Campaigns
          </Link>
        </div>
      </div>

      <form className="rounded-xl border border-border bg-surface p-4">
        <input
          name="q"
          defaultValue={query}
          placeholder="Search by name or number..."
          className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text"
        />
      </form>

      <div className="grid gap-4 lg:grid-cols-2">
        {connections.map((connection) => {
          const stats = statsByConnection.get(connection.id);
          return (
            <div key={connection.id} className="rounded-xl border border-border bg-surface p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold text-text">
                    {connection.phoneDisplayNumber || "Unnamed WhatsApp number"}
                  </h2>
                  <p className="mt-1 text-xs text-text-dim">{connection.phoneNumberId}</p>
                </div>
                <span className="rounded-full border border-border px-2.5 py-1 text-xs text-text-muted">
                  Quality {connection.currentQualityRating}
                </span>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                <Metric
                  label="Current limit"
                  value={connection.dailyLimitEstimate?.toLocaleString("en-ZA") || "Unknown"}
                />
                <Metric
                  label="Remaining"
                  value={stats?.estimatedRemainingToday?.toLocaleString("en-ZA") || "Unknown"}
                />
                <Metric
                  label="Sent 24h"
                  value={stats?.sentLast24h.toLocaleString("en-ZA") || "0"}
                />
              </div>
            </div>
          );
        })}
      </div>

      <NewWhatsappConversationCard
        connections={connections.map((connection) => ({
          id: connection.id,
          phoneNumberId: connection.phoneNumberId,
          phoneDisplayNumber: connection.phoneDisplayNumber,
        }))}
        templates={templates}
      />

      <LiveWhatsappConversationList
        initialConversations={conversations.map((conversation) => {
          const lastMessage = conversation.messages[0];
          const parsed = parseWhatsappConversationIdentifier(conversation.customerIdentifier);

          return {
            id: conversation.id,
            customerName: conversation.customerName,
            phone: parsed?.phone || conversation.customerIdentifier,
            lastMessageAt: conversation.lastMessageAt.toISOString(),
            unreadCount: conversation.unreadCount,
            lastMessage: lastMessage
              ? {
                  sender: lastMessage.sender as "customer" | "bot",
                  content: lastMessage.content,
                }
              : null,
          };
        })}
      />
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface-2 p-3">
      <p className="text-[11px] uppercase tracking-[0.15em] text-text-dim">{label}</p>
      <p className="mt-1 text-lg font-semibold text-text">{value}</p>
    </div>
  );
}
