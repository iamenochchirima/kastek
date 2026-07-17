import { fetchFromCore } from "@/lib/admin-auth";
import Link from "next/link";
import { Globe2, MessageCircle } from "lucide-react";
import { AdminPageHeader } from "@/components/admin/page-header";
import { StatusBadge } from "@/components/admin/status-badge";

interface Conversation {
  id: string;
  channel: string;
  customerIdentifier: string;
  customerName: string | null;
  status: string;
  lastMessageAt: string;
}

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string; search?: string }>;
}) {
  const params = await searchParams;

  const qs = new URLSearchParams();
  if (params.channel) qs.set("channel", params.channel);
  if (params.search) qs.set("search", params.search);

  const res = await fetchFromCore(`/api/admin/conversations?${qs.toString()}`);
  const conversations: Conversation[] = res.ok ? await res.json() : [];

  return (
    <div className="admin-page">
      <AdminPageHeader title="Conversations" description={`${conversations.length} conversation${conversations.length === 1 ? "" : "s"} matching the current filters.`} />

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <form className="flex-1 min-w-[200px]" action="/conversations">
          <input
            name="search"
            type="text"
            placeholder="Search by name or number..."
            defaultValue={params.search || ""}
            className="w-full px-3 py-2 bg-surface-raised border border-border rounded-lg text-sm text-text placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          {params.channel && <input type="hidden" name="channel" value={params.channel} />}
        </form>

        <div className="flex gap-2">
          <Link
            href="/conversations"
            className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              !params.channel
                ? "bg-primary/15 text-primary"
                : "text-text-muted hover:bg-surface-overlay"
            }`}
          >
            All
          </Link>
          <Link
            href="/conversations?channel=whatsapp"
            className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              params.channel === "whatsapp"
                ? "bg-green-500/15 text-green-400"
                : "text-text-muted hover:bg-surface-overlay"
            }`}
          >
            WhatsApp
          </Link>
          <Link
            href="/conversations?channel=website"
            className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
              params.channel === "website"
                ? "bg-blue-500/15 text-blue-400"
                : "text-text-muted hover:bg-surface-overlay"
            }`}
          >
            Website
          </Link>
        </div>
      </div>

      {/* Conversations list */}
      <div className="overflow-hidden rounded-lg border border-border bg-card">
        {conversations.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-text-faint">No conversations yet</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {conversations.map((conv) => (
              <Link
                key={conv.id}
                href={`/conversations/${conv.id}`}
                className="flex items-center gap-4 px-4 py-4 hover:bg-surface-overlay transition-colors"
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
                  {conv.channel === "whatsapp" ? <MessageCircle className="size-5" /> : <Globe2 className="size-5" />}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <p className="font-medium text-sm text-text truncate">
                      {conv.customerName ?? conv.customerIdentifier}
                    </p>
                    <StatusBadge value={conv.channel} className="text-[10px]" />
                  </div>
                </div>

                <div className="text-xs text-text-faint shrink-0">
                  {new Date(conv.lastMessageAt).toLocaleDateString()}
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
