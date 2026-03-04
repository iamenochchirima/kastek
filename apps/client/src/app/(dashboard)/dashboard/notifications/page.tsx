import { auth } from "@/auth";
import NotificationActions from "@/components/dashboard/notifications/notification-actions";
import {
  NotificationRecipientType,
  listNotificationInbox,
} from "@kasitek/database";
import Link from "next/link";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Notifications | KasiTek",
};

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ cursor?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;
  const { items, unreadCount, nextCursor } = await listNotificationInbox(
    NotificationRecipientType.USER,
    session.user.id,
    {
      limit: 30,
      cursor: params.cursor,
    }
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="mb-2 text-3xl font-semibold tracking-tight">Notifications</h1>
          <p className="text-text-muted">
            Important template, campaign, and system updates appear here.
          </p>
        </div>

        <NotificationActions />
      </div>

      <section className="grid gap-4 md:grid-cols-2">
        <MetricCard label="Unread" value={unreadCount.toString()} />
        <MetricCard label="On this page" value={items.length.toString()} />
      </section>

      <section className="space-y-3">
        {items.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-surface p-10 text-center text-sm text-text-muted">
            No notifications yet.
          </div>
        ) : (
          items.map((notification) => {
            const entityHref = buildNotificationHref(
              notification.entityType,
              notification.entityId,
              notification.payload
            );
            const isUnread = notification.isUnread;

            return (
              <div
                key={notification.eventId}
                className={`rounded-2xl border p-5 ${
                  isUnread ? "border-accent/30 bg-accent/5" : "border-border bg-surface"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${severityClass(
                          notification.severity
                        )}`}
                      >
                        {notification.severity}
                      </span>
                      <span className="rounded-full border border-border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-text-dim">
                        {notification.status}
                      </span>
                    </div>

                    <h2 className="text-lg font-semibold text-text">{notification.title}</h2>
                    <p className="mt-1 text-sm text-text-muted">{notification.message}</p>
                    <p className="mt-3 text-xs text-text-dim">
                      {notification.createdAt.toLocaleString("en-ZA")}
                    </p>

                    {notification.emailDeliveryStatus ? (
                      <p className="mt-2 text-xs text-text-dim">
                        Email delivery: {notification.emailDeliveryStatus}
                        {notification.emailDeliveryError ? ` · ${notification.emailDeliveryError}` : ""}
                      </p>
                    ) : null}
                  </div>

                  {entityHref ? (
                    <Link
                      href={entityHref}
                      className="rounded-full border border-border px-3 py-1.5 text-xs font-medium text-text no-underline transition-colors hover:border-border-light hover:bg-surface-2"
                    >
                      Open
                    </Link>
                  ) : null}
                </div>
              </div>
            );
          })
        )}

        {nextCursor ? (
          <div className="pt-1">
            <Link
              href={`/dashboard/notifications?cursor=${encodeURIComponent(nextCursor)}`}
              className="inline-flex rounded-full border border-border px-4 py-2 text-sm font-medium text-text no-underline transition-colors hover:border-border-light hover:bg-surface-2"
            >
              Load older notifications
            </Link>
          </div>
        ) : null}
      </section>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-border bg-surface p-5">
      <p className="text-[11px] uppercase tracking-[0.16em] text-text-dim">{label}</p>
      <p className="mt-2 text-3xl font-semibold text-text">{value}</p>
    </div>
  );
}

function severityClass(severity: string) {
  if (severity === "CRITICAL") return "border-red-500/30 bg-red-500/10 text-red-300";
  if (severity === "WARNING") return "border-amber-500/30 bg-amber-500/10 text-amber-300";
  if (severity === "SUCCESS") return "border-green-500/30 bg-green-500/10 text-green-300";
  return "border-border bg-surface-2 text-text-muted";
}

function buildNotificationHref(
  entityType: string | null,
  entityId: string | null,
  payload: unknown
) {
  const eventPayload = (payload || {}) as Record<string, unknown>;

  if (entityType === "conversation") {
    const conversationId =
      entityId || (typeof eventPayload.conversationId === "string" ? eventPayload.conversationId : null);
    return conversationId ? `/dashboard/inbox/whatsapp/${conversationId}` : null;
  }

  if (entityType === "campaign") {
    return entityId ? `/dashboard/campaigns/whatsapp/${entityId}` : null;
  }

  if (entityType === "template") {
    return "/dashboard/templates/whatsapp";
  }

  if (entityType === "connection") {
    return "/dashboard/settings";
  }

  return null;
}
