import { fetchFromCore } from "@/lib/admin-auth";
import Link from "next/link";
import { Globe2, MessageCircle } from "lucide-react";
import { AdminPageHeader } from "@/components/admin/page-header";
import { StatusBadge } from "@/components/admin/status-badge";
import { Input } from "@/components/ui/input";

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
      <div className="flex flex-wrap items-center gap-3 rounded-[calc(var(--radius)-1px)] border border-line bg-card p-3 shadow-card">
        <form className="min-w-[200px] flex-1" action="/conversations">
          <Input
            name="search"
            type="text"
            placeholder="Search by name or number..."
            defaultValue={params.search || ""}
          />
          {params.channel && <input type="hidden" name="channel" value={params.channel} />}
        </form>

        <div className="flex gap-2">
          <Link
            href="/conversations"
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              !params.channel
                ? "bg-primary/15 text-primary"
                : "text-muted-foreground hover:bg-accent"
            }`}
          >
            All
          </Link>
          <Link
            href="/conversations?channel=whatsapp"
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              params.channel === "whatsapp"
                ? "bg-status-success-soft text-status-success"
                : "text-muted-foreground hover:bg-accent"
            }`}
          >
            WhatsApp
          </Link>
          <Link
            href="/conversations?channel=website"
            className={`rounded-md px-3 py-2 text-sm font-medium transition-colors ${
              params.channel === "website"
                ? "bg-status-info-soft text-status-info"
                : "text-muted-foreground hover:bg-accent"
            }`}
          >
            Website
          </Link>
        </div>
      </div>

      {/* Conversations list */}
      <div className="v-card overflow-hidden">
        {conversations.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm text-muted-foreground">No conversations yet</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {conversations.map((conv) => (
              <Link
                key={conv.id}
                href={`/conversations/${conv.id}`}
                className="flex items-center gap-4 px-4 py-4 transition-colors hover:bg-accent"
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                  {conv.channel === "whatsapp" ? <MessageCircle className="size-5" /> : <Globe2 className="size-5" />}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5">
                    <p className="truncate text-sm font-medium text-foreground">
                      {conv.customerName ?? conv.customerIdentifier}
                    </p>
                    <StatusBadge value={conv.channel} className="text-[10px]" />
                  </div>
                </div>

                <div className="shrink-0 text-xs text-muted-foreground">
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
