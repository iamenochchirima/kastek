"use client";

import { Link } from "react-router";
import { useEffect, useMemo, useState } from "react";
import { BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
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
    <div className="mx-auto mb-6 max-w-[1440px] px-6 pt-6 lg:px-8 lg:pt-8">
      <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border bg-card p-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-secondary text-muted-foreground">
            <BellRing className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-foreground">Enable mobile notifications</p>
            <p className="mt-1 text-sm text-muted-foreground">{configured ? "New inbox messages." : "Notification service is unavailable."}</p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button asChild><Link to="/workspace/settings?section=notifications">Enable</Link></Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setDismissed(true);
              if (typeof window !== "undefined") {
                window.localStorage.setItem(REMINDER_DISMISS_KEY, "true");
              }
            }}
          >
            Not now
          </Button>
        </div>
      </div>
    </div>
  );
}
