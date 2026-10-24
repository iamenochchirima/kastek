import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { Bell, CheckCircle2, CircleAlert, Info, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WhatsappRealtimeEvent } from "@/lib/whatsapp/types";
import {
  useWhatsappInboxUnreadCount,
  useWhatsappRealtimeSubscription,
} from "@/components/dashboard/whatsapp-realtime-provider";

type NotificationTone = "attention" | "success" | "danger" | "info";

type NotificationItem = {
  id: string;
  title: string;
  description: string;
  occurredAt: string;
  href: string;
  tone: NotificationTone;
};

function relativeTime(value: string) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function eventToNotification(event: WhatsappRealtimeEvent): NotificationItem | null {
  const occurredAt = new Date().toISOString();
  if (event.type === "message.created" && event.message.sender === "customer") {
    const customer = event.conversation?.customerName?.trim() || event.conversation?.phone || "New inbox message";
    return {
      id: `message:${event.message.id}`,
      title: customer,
      description: event.message.content.trim() || "New WhatsApp message",
      occurredAt: event.message.timestamp || occurredAt,
      href: `/inbox?conversation=${encodeURIComponent(event.conversationId)}`,
      tone: "info",
    };
  }
  if (event.type === "message.send_failed") {
    return {
      id: `send-failed:${event.conversationId}:${occurredAt}`,
      title: "Message failed",
      description: event.error || "A message could not be sent.",
      occurredAt,
      href: `/inbox?conversation=${encodeURIComponent(event.conversationId)}`,
      tone: "danger",
    };
  }
  if (event.type === "campaign.updated") {
    return {
      id: `campaign:${event.campaignId}:${occurredAt}`,
      title: "Campaign updated",
      description: `Campaign is ${event.campaign.status.toLowerCase().replaceAll("_", " ")}.`,
      occurredAt: event.campaign.updatedAt || occurredAt,
      href: `/campaigns/${encodeURIComponent(event.campaignId)}`,
      tone: event.campaign.status === "FAILED" ? "danger" : "success",
    };
  }
  if (event.type === "call.created") {
    return {
      id: `call:${event.callId}`,
      title: event.call.conversationCustomerName?.trim() || "New call",
      description: `${event.call.direction.toLowerCase()} call · ${event.call.status.toLowerCase()}`,
      occurredAt: event.call.startedAt || occurredAt,
      href: "/calls",
      tone: "attention",
    };
  }
  return null;
}

function ToneIcon({ tone }: { tone: NotificationTone }) {
  if (tone === "success") return <CheckCircle2 className="size-3.5 text-status-success" aria-hidden="true" />;
  if (tone === "danger") return <XCircle className="size-3.5 text-destructive" aria-hidden="true" />;
  if (tone === "attention") return <CircleAlert className="size-3.5 text-status-attention" aria-hidden="true" />;
  return <Info className="size-3.5 text-primary" aria-hidden="true" />;
}

export function NotificationPopover({ className, buttonClassName }: { className?: string; buttonClassName?: string }) {
  const unreadCount = useWhatsappInboxUnreadCount();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  const handleEvent = useCallback((event: WhatsappRealtimeEvent) => {
    const item = eventToNotification(event);
    if (!item) return;
    setItems((current) => [item, ...current.filter((candidate) => candidate.id !== item.id)].slice(0, 4));
  }, []);

  useWhatsappRealtimeSubscription(handleEvent);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div ref={rootRef} className={cn("relative", className)}>
      <button
        type="button"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : "Notifications"}
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
        className={cn("relative grid size-9 place-items-center rounded-md border border-line bg-surface text-ink-2 transition-colors duration-150 hover:bg-surface-2 hover:text-ink-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring", buttonClassName)}
      >
        <Bell className="size-4" />
        {unreadCount > 0 ? <span className="absolute right-1 top-1 size-1.5 rounded-full bg-status-attention" aria-hidden="true" /> : null}
      </button>

      {open ? (
        <section className="absolute right-0 top-[calc(100%+0.5rem)] z-[var(--z-popover)] w-[min(360px,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-[var(--shadow-popover)]" aria-label="Recent notifications">
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <h2 className="text-sm font-semibold">Notifications</h2>
            {unreadCount > 0 ? <span className="rounded-full bg-status-attention-soft px-2 py-1 text-[10px] font-semibold text-status-attention">{unreadCount > 99 ? "99+" : unreadCount} new</span> : null}
          </header>

          {items.length || unreadCount > 0 ? (
            <div className="divide-y divide-border">
              {items.length ? items.map((item) => (
                <Link key={item.id} to={item.href} onClick={() => setOpen(false)} className="flex gap-3 px-4 py-3 transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary"><ToneIcon tone={item.tone} /></span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{item.title}</span>
                    <span className="mt-0.5 block line-clamp-2 text-xs leading-5 text-muted-foreground">{item.description}</span>
                    <span className="mt-1 block text-[10px] text-muted-foreground">{relativeTime(item.occurredAt)}</span>
                  </span>
                </Link>
              )) : (
                <Link to="/inbox" onClick={() => setOpen(false)} className="flex gap-3 px-4 py-4 transition-colors hover:bg-secondary/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-secondary"><Info className="size-3.5 text-primary" aria-hidden="true" /></span>
                  <span><span className="block text-[13px] font-medium">Unread inbox messages</span><span className="mt-0.5 block text-xs text-muted-foreground">{unreadCount} conversation{unreadCount === 1 ? "" : "s"} need attention.</span><span className="mt-1 block text-[10px] text-muted-foreground">now</span></span>
                </Link>
              )}
            </div>
          ) : (
            <p className="px-4 py-8 text-center text-xs text-muted-foreground">No recent notifications</p>
          )}

          <footer className="border-t border-border px-4 py-2.5">
            <Link to="/workspace/settings?section=notifications" onClick={() => setOpen(false)} className="text-xs font-medium text-primary hover:underline">Notification settings</Link>
          </footer>
        </section>
      ) : null}
    </div>
  );
}
