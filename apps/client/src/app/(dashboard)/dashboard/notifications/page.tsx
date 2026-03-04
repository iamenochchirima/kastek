import { auth } from "@/auth";
import NotificationActions from "@/components/dashboard/notifications/notification-actions";
import {
  NotificationChannel,
  NotificationRecipientType,
  NotificationStatus,
  listNotifications,
  prisma,
} from "@kasiai/database";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

export const metadata = {
  title: "Notifications | KasiAI",
};

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ channel?: string; unread?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/login");

  const params = await searchParams;
  const unreadOnly = params.unread === "true";
  const channel =
    params.channel === NotificationChannel.EMAIL || params.channel === NotificationChannel.IN_APP
      ? params.channel
      : undefined;

  const [notifications, counts, unreadCount] = await Promise.all([
    listNotifications(NotificationRecipientType.USER, session.user.id, {
      channel,
      unreadOnly,
      limit: 100,
    }),
    prisma.notification.groupBy({
      by: ["channel"],
      where: {
        recipientType: NotificationRecipientType.USER,
        recipientId: session.user.id,
      },
      _count: true,
    }),
    prisma.notification.count({
      where: {
        recipientType: NotificationRecipientType.USER,
        recipientId: session.user.id,
        channel: NotificationChannel.IN_APP,
        readAt: null,
        status: {
          notIn: [NotificationStatus.DISMISSED, NotificationStatus.FAILED],
        },
      },
    }),
  ]);

  const channelCounts = Object.fromEntries(counts.map((item) => [item.channel, item._count])) as Record<
    string,
    number
  >;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="mb-2 text-3xl font-semibold tracking-tight">Notifications</h1>
          <p className="text-text-muted">
            Review inbox, template, campaign, and system notifications in one place. Email-worthy
            events are logged here as well.
          </p>
        </div>

        <NotificationActions />
      </div>

      <section className="grid gap-4 md:grid-cols-3">
        <MetricCard label="Unread In-App" value={unreadCount.toString()} />
        <MetricCard
          label="In-App Logged"
          value={String(channelCounts[NotificationChannel.IN_APP] || 0)}
        />
        <MetricCard
          label="Email Logged"
          value={String(channelCounts[NotificationChannel.EMAIL] || 0)}
        />
      </section>

      <section className="flex flex-wrap gap-2">
        <FilterLink href="/dashboard/notifications" active={!channel && !unreadOnly}>
          All
        </FilterLink>
        <FilterLink href="/dashboard/notifications?unread=true" active={unreadOnly && !channel}>
          Unread
        </FilterLink>
        <FilterLink
          href={`/dashboard/notifications?channel=${NotificationChannel.IN_APP}`}
          active={channel === NotificationChannel.IN_APP}
        >
          In-App
        </FilterLink>
        <FilterLink
          href={`/dashboard/notifications?channel=${NotificationChannel.EMAIL}`}
          active={channel === NotificationChannel.EMAIL}
        >
          Email
        </FilterLink>
      </section>

      <section className="space-y-3">
        {notifications.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-border bg-surface p-10 text-center text-sm text-text-muted">
            No notifications match the current filter.
          </div>
        ) : (
          notifications.map((notification) => {
            const latestDelivery = notification.deliveryLogs[0];
            const entityHref = buildNotificationHref(
              notification.event.entityType,
              notification.event.entityId,
              notification.event.payload
            );
            const isUnread =
              notification.channel === NotificationChannel.IN_APP &&
              notification.readAt === null &&
              notification.status !== NotificationStatus.DISMISSED &&
              notification.status !== NotificationStatus.FAILED;

            return (
              <div
                key={notification.id}
                className={`rounded-2xl border p-5 ${
                  isUnread ? "border-accent/30 bg-accent/5" : "border-border bg-surface"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span
                        className={`rounded-full border px-2.5 py-1 text-[11px] font-medium uppercase tracking-[0.16em] ${severityClass(
                          notification.event.severity
                        )}`}
                      >
                        {notification.event.severity}
                      </span>
                      <span className="rounded-full border border-border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-text-muted">
                        {notification.channel === NotificationChannel.EMAIL ? "Email" : "In-App"}
                      </span>
                      <span className="rounded-full border border-border px-2.5 py-1 text-[11px] uppercase tracking-[0.16em] text-text-dim">
                        {notification.status}
                      </span>
                    </div>

                    <h2 className="text-lg font-semibold text-text">{notification.event.title}</h2>
                    <p className="mt-1 text-sm text-text-muted">{notification.event.message}</p>
                    <p className="mt-3 text-xs text-text-dim">
                      {notification.createdAt.toLocaleString("en-ZA")}
                    </p>
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

                {notification.channel === NotificationChannel.EMAIL ? (
                  <div className="mt-4 rounded-xl border border-border bg-surface-2 p-4 text-sm text-text-muted">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <span>Email delivery status</span>
                      <span className="font-medium text-text">
                        {latestDelivery?.status || notification.status}
                      </span>
                    </div>
                    {latestDelivery?.provider ? (
                      <p className="mt-2 text-xs text-text-dim">Provider: {latestDelivery.provider}</p>
                    ) : null}
                    {latestDelivery?.errorMessage || notification.errorMessage ? (
                      <p className="mt-2 text-xs text-red-300">
                        {latestDelivery?.errorMessage || notification.errorMessage}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}

function FilterLink({
  href,
  active,
  children,
}: {
  href: string;
  active: boolean;
  children: ReactNode;
}) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1.5 text-sm no-underline transition-colors ${
        active
          ? "border-accent/30 bg-accent/10 text-accent"
          : "border-border bg-surface text-text-muted hover:border-border-light hover:text-text"
      }`}
    >
      {children}
    </Link>
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
