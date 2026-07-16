"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { BellRing } from "lucide-react";
import {
  fetchPushStatus,
  getLocalPushSupport,
} from "@/components/dashboard/notifications/push-notification-client";

const REMINDER_DISMISS_KEY = "kasitek:push-reminder-dismissed";

export default function PushNotificationReminder() {
  const support = useMemo(() => getLocalPushSupport(), []);
  const [dismissed, setDismissed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(REMINDER_DISMISS_KEY) === "true";
  });
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [configured, setConfigured] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;

    if (
      !support.notifications ||
      !support.serviceWorker ||
      !support.pushManager ||
      !support.secureContext ||
      !support.standalone
    ) {
      return;
    }

    const load = async () => {
      try {
        const status = await fetchPushStatus();
        if (cancelled) return;
        setSubscribed(status.subscribed);
        setConfigured(status.configured);
      } catch {
        if (cancelled) return;
        setSubscribed(true);
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [support]);

  if (dismissed || subscribed !== false) {
    return null;
  }

  return (
    <div className="mx-auto mb-6 max-w-[1600px] px-6 pt-6 lg:px-8 lg:pt-8">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border bg-card p-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
            <BellRing className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Enable mobile notifications</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Turn on notifications so new WhatsApp inbox messages can reach you like a normal phone notification.
              {!configured ? " The server is not fully configured yet." : ""}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Link
            href="/workspace/notifications"
            className="rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground no-underline transition-opacity hover:opacity-90"
          >
            Enable now
          </Link>
          <button
            type="button"
            onClick={() => {
              setDismissed(true);
              if (typeof window !== "undefined") {
                window.localStorage.setItem(REMINDER_DISMISS_KEY, "true");
              }
            }}
            className="rounded-md border border-border bg-card px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
          >
            Not now
          </button>
        </div>
      </div>
    </div>
  );
}
