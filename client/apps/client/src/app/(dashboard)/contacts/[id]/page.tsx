import { getRustSession } from "@/lib/rust-auth";
import { fetchRustJson } from "@/lib/rust-server-api";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";

type CustomerDetailResponse = {
  customer: {
    id: string;
    displayName: string | null;
    createdAt: string;
  };
  identities: Array<{
    id: string;
    channel: string;
    scopeId: string | null;
    externalId: string;
    displayName: string | null;
  }>;
  contacts: Array<{
    id: string;
    phone: string;
    fullName: string | null;
    tags: string[];
    listLabel: string;
    optIn: boolean;
    optInSource: string | null;
    optInDate: string | null;
    excluded: boolean;
    notes: string | null;
    lastMarketingSent: string | null;
  }>;
  conversations: Array<{
    id: string;
    channel: string;
    customerIdentifier: string;
    status: string;
    lastMessageAt: string;
    unreadCount: number;
    connectionLabel: string | null;
  }>;
  campaigns: Array<{
    id: string;
    name: string;
    status: string;
    templateName: string;
    sentCount: number;
    deliveredCount: number;
    readCount: number;
    lastSentAt: string | null;
  }>;
  bookings: Array<{
    id: string;
    serviceName: string;
    contactName: string;
    scheduledStart: string;
    scheduledEnd: string;
    timezone: string;
    status: string;
    notes: string | null;
  }>;
  agentEvents: Array<{
    id: string;
    eventType: string;
    channel: string | null;
    status: string | null;
    responseTimeMs: number | null;
    createdAt: string;
    agentName: string;
  }>;
};

function label(value: string) {
  return value ? `${value.slice(0, 1).toUpperCase()}${value.slice(1)}` : "Unknown";
}

function dateTime(value: string | null) {
  return value ? new Date(value).toLocaleString("en-ZA") : "Never";
}

export const metadata = {
  title: "Customer | KasiTek",
};

export default async function CustomerDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const { id } = await params;
  let detail: CustomerDetailResponse;
  try {
    detail = await fetchRustJson<CustomerDetailResponse>(`/api/customers/${encodeURIComponent(id)}`);
  } catch {
    notFound();
  }

  const customerName = detail.customer.displayName || detail.contacts[0]?.fullName || "Unnamed customer";

  return (
    <div className="min-h-screen p-4 sm:p-6 lg:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <Link href="/contacts" className="text-sm text-muted-foreground hover:text-foreground">
          ← Back to Contacts
        </Link>

        <section className="rounded-2xl border border-border bg-card p-6">
          <p className="text-sm font-medium text-muted-foreground">Customer</p>
          <div className="mt-2 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h1 className="text-3xl font-semibold tracking-tight text-foreground">{customerName}</h1>
              <p className="mt-2 text-sm text-muted-foreground">
                Customer record created {dateTime(detail.customer.createdAt)}.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-sm">
              <span className="rounded-full border border-border px-3 py-1.5 text-muted-foreground">
                {detail.identities.length} identities
              </span>
              <span className="rounded-full border border-border px-3 py-1.5 text-muted-foreground">
                {detail.conversations.length} conversations
              </span>
              <span className="rounded-full border border-border px-3 py-1.5 text-muted-foreground">
                {detail.bookings.length} bookings
              </span>
            </div>
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(280px,0.75fr)]">
          <section className="rounded-2xl border border-border bg-card p-6">
            <h2 className="text-lg font-semibold text-foreground">Channel identities</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              These remain separate provider identities. Matching names are not merged automatically.
            </p>
            <div className="mt-5 space-y-3">
              {detail.identities.length ? (
                detail.identities.map((identity) => (
                  <div key={identity.id} className="rounded-xl border border-border bg-secondary/20 p-4">
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-foreground">{label(identity.channel)}</p>
                        <p className="mt-1 break-all text-sm text-muted-foreground">{identity.externalId}</p>
                      </div>
                      <span className="rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">
                        {identity.scopeId ? "Account scoped" : "Workspace scoped"}
                      </span>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No channel identities have been recorded yet.</p>
              )}
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-card p-6">
            <h2 className="text-lg font-semibold text-foreground">WhatsApp consent</h2>
            <div className="mt-5 space-y-4">
              {detail.contacts.length ? (
                detail.contacts.map((contact) => (
                  <div key={contact.id} className="rounded-xl border border-border bg-secondary/20 p-4 text-sm">
                    <p className="font-medium text-foreground">{contact.phone}</p>
                    <p className="mt-1 text-muted-foreground">List: {contact.listLabel}</p>
                    <p className="mt-2 text-muted-foreground">
                      {contact.excluded
                        ? "Excluded from marketing"
                        : contact.optIn
                          ? `Opted in${contact.optInSource ? ` via ${contact.optInSource}` : ""}`
                          : "No recorded opt-in"}
                    </p>
                    {contact.tags.length ? (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {contact.tags.map((tag) => (
                          <span key={tag} className="rounded-full border border-border px-2 py-1 text-xs text-muted-foreground">
                            {tag}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">No WhatsApp contact record is linked yet.</p>
              )}
            </div>
          </section>
        </div>

        <section className="rounded-2xl border border-border bg-card p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Conversations</h2>
              <p className="mt-1 text-sm text-muted-foreground">Recent messages across connected customer channels.</p>
            </div>
            <Link href="/inbox" className="text-sm text-muted-foreground hover:text-foreground">
              Open Inbox →
            </Link>
          </div>
          <div className="mt-5 divide-y divide-border rounded-xl border border-border">
            {detail.conversations.length ? (
              detail.conversations.map((conversation) => (
                <div key={conversation.id} className="flex flex-col gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-medium text-foreground">{label(conversation.channel)} conversation</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {conversation.connectionLabel || conversation.customerIdentifier}
                    </p>
                  </div>
                  <div className="text-sm text-muted-foreground sm:text-right">
                    <p>{conversation.unreadCount ? `${conversation.unreadCount} unread` : label(conversation.status)}</p>
                    <p className="mt-1 text-xs">{dateTime(conversation.lastMessageAt)}</p>
                  </div>
                </div>
              ))
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground">No conversations are linked to this customer yet.</p>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold text-foreground">Campaign participation</h2>
          <div className="mt-5 space-y-3">
            {detail.campaigns.length ? (
              detail.campaigns.map((campaign) => (
                <Link
                  key={campaign.id}
                  href={`/campaigns/${campaign.id}`}
                  className="flex flex-col gap-2 rounded-xl border border-border bg-secondary/20 p-4 transition-colors hover:bg-secondary/40 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div>
                    <p className="font-medium text-foreground">{campaign.name}</p>
                    <p className="mt-1 text-sm text-muted-foreground">Template: {campaign.templateName}</p>
                  </div>
                  <div className="text-sm text-muted-foreground sm:text-right">
                    <p>{label(campaign.status)}</p>
                    <p className="mt-1 text-xs">
                      {campaign.deliveredCount} delivered · {campaign.readCount} read
                    </p>
                  </div>
                </Link>
              ))
            ) : (
              <p className="text-sm text-muted-foreground">This customer has not been included in a WhatsApp campaign.</p>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-card p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Bookings</h2>
              <p className="mt-1 text-sm text-muted-foreground">Appointments and outcomes recorded for this customer.</p>
            </div>
            <Link href="/bookings" className="text-sm text-muted-foreground hover:text-foreground">
              Open Bookings →
            </Link>
          </div>
          <div className="mt-5 divide-y divide-border rounded-xl border border-border">
            {detail.bookings.length ? (
              detail.bookings.map((booking) => (
                <div key={booking.id} className="flex flex-col gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-medium text-foreground">{booking.serviceName}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {dateTime(booking.scheduledStart)} · {booking.timezone}
                    </p>
                    {booking.notes ? <p className="mt-1 text-sm text-muted-foreground">{booking.notes}</p> : null}
                  </div>
                  <p className="text-sm text-muted-foreground sm:text-right">{label(booking.status.replaceAll("_", " "))}</p>
                </div>
              ))
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground">No bookings are linked to this customer yet.</p>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-border bg-card p-6">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Agent Platform activity</h2>
              <p className="mt-1 text-sm text-muted-foreground">Runs linked to this customer or their conversation will appear here.</p>
            </div>
            <Link href="/agents" className="text-sm text-muted-foreground hover:text-foreground">
              Open Agents →
            </Link>
          </div>
          <div className="mt-5 divide-y divide-border rounded-xl border border-border">
            {detail.agentEvents.length ? (
              detail.agentEvents.map((event) => (
                <div key={event.id} className="flex flex-col gap-2 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-medium text-foreground">{event.agentName}</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {label(event.eventType.replace("agent.", "").replaceAll("_", " "))}
                      {event.channel ? ` · ${label(event.channel)}` : ""}
                    </p>
                  </div>
                  <div className="text-sm text-muted-foreground sm:text-right">
                    <p>{event.status ? label(event.status) : "Recorded"}</p>
                    <p className="mt-1 text-xs">
                      {event.responseTimeMs ? `${event.responseTimeMs} ms · ` : ""}
                      {dateTime(event.createdAt)}
                    </p>
                  </div>
                </div>
              ))
            ) : (
              <p className="px-4 py-6 text-sm text-muted-foreground">No Agent Platform runs have been linked to this customer yet.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
