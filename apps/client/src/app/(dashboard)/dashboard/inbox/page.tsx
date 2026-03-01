import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { redirect } from "next/navigation";
import Link from "next/link";
import {
  parseWhatsappConversationIdentifier,
} from "@/lib/whatsapp/inbox";
import WhatsappManualConnectionCard from "@/components/dashboard/settings/whatsapp-manual-connection-card";

export const metadata = {
  title: "Inbox | KasiAI",
};

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;
  const query = params.q?.trim() || "";

  const connections = await prisma.whatsappConnection.findMany({
    where: {
      userId: session.user.id,
    },
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
    orderBy: {
      createdAt: "desc",
    },
  });

  if (!connections.length) {
    return (
      <div className="space-y-6">
        <div>
          <h1 className="mb-2 font-serif text-3xl">Inbox</h1>
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
    orderBy: {
      lastMessageAt: "desc",
    },
    include: {
      messages: {
        orderBy: {
          timestamp: "desc",
        },
        take: 1,
      },
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="mb-2 font-serif text-3xl">Inbox</h1>
          <p className="text-text-muted">
            View WhatsApp conversations captured after your number was connected to KasiAI.
          </p>
        </div>
        <Link
          href="/dashboard/campaigns"
          className="rounded-lg border border-border px-4 py-2 text-sm text-text no-underline hover:border-border-light"
        >
          Go to Campaigns
        </Link>
      </div>

      <form className="rounded-xl border border-border bg-surface p-4">
        <input
          name="q"
          defaultValue={query}
          placeholder="Search by name or number..."
          className="w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-text"
        />
      </form>

      <div className="overflow-hidden rounded-xl border border-border bg-surface">
        {conversations.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm text-text-muted">
              No WhatsApp conversations captured yet. New messages will appear here from the time
              your number is connected to KasiAI.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {conversations.map((conversation) => {
              const lastMessage = conversation.messages[0];
              const parsed = parseWhatsappConversationIdentifier(conversation.customerIdentifier);
              return (
                <Link
                  key={conversation.id}
                  href={`/dashboard/inbox/${conversation.id}`}
                  className="flex items-center gap-4 px-4 py-4 no-underline transition-colors hover:bg-surface-2/40"
                >
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-500/15 text-lg text-green-300">
                    💬
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="mb-0.5 flex items-center gap-2">
                      <p className="truncate text-sm font-medium text-text">
                        {conversation.customerName || parsed?.phone || "Unknown"}
                      </p>
                    </div>
                    <p className="text-xs text-text-dim">{parsed?.phone || conversation.customerIdentifier}</p>
                    {lastMessage ? (
                      <p className="mt-1 truncate text-xs text-text-muted">
                        {lastMessage.sender === "bot" ? "You: " : ""}
                        {lastMessage.content}
                      </p>
                    ) : null}
                  </div>

                  <div className="shrink-0 text-xs text-text-dim">
                    {conversation.lastMessageAt.toLocaleDateString("en-ZA")}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
