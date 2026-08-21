"use client";

import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "@/lib/server-api";
import { Button } from "@/components/ui/button";
import {
  fetchPushStatus,
  getLocalPushSupport,
  type PushStatusResponse,
  urlBase64ToUint8Array,
} from "@/components/dashboard/notifications/push-notification-client";

export default function PushNotificationSettings() {
  const support = useMemo(() => getLocalPushSupport(), []);
  const [status, setStatus] = useState<PushStatusResponse | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const next = await fetchPushStatus();
        if (!cancelled) {
          setStatus(next);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : "Failed to load push status");
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  async function ensureServiceWorkerRegistration() {
    const existing = await navigator.serviceWorker.getRegistration();
    if (existing) return existing;
    return navigator.serviceWorker.register("/sw.js", { scope: "/" });
  }

  async function subscribe() {
    if (!support.notifications || !support.serviceWorker || !support.pushManager || !support.secureContext) {
      setError("This device or browser does not support web push notifications.");
      return;
    }
    if (!status?.configured || !status.publicKey) {
      setError("Push notifications are not configured on the server yet.");
      return;
    }

    setBusyAction("subscribe");
    setMessage(null);
    setError(null);

    try {
      const nextPermission = await window.Notification.requestPermission();
      if (nextPermission !== "granted") {
        throw new Error("Notification permission was not granted.");
      }

      const registration = await ensureServiceWorkerRegistration();
      const existingSubscription = await registration.pushManager.getSubscription();
      const subscription =
        existingSubscription ||
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(status.publicKey),
        }));

      const response = await fetch(apiUrl("/api/notifications/push/subscribe"), {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          subscription: subscription.toJSON(),
        }),
      });

      if (!response.ok) {
        throw new Error("Failed to save this device subscription.");
      }

      const nextStatus = await fetchPushStatus();
      setStatus(nextStatus);
      setMessage("Push notifications are enabled for this device.");
    } catch (subscribeError) {
      setError(subscribeError instanceof Error ? subscribeError.message : "Failed to enable push notifications");
    } finally {
      setBusyAction(null);
    }
  }

  async function unsubscribe() {
    if (!support.serviceWorker) {
      setError("Service workers are not available on this device.");
      return;
    }

    setBusyAction("unsubscribe");
    setMessage(null);
    setError(null);

    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = registration ? await registration.pushManager.getSubscription() : null;

      if (subscription) {
        await fetch(apiUrl("/api/notifications/push/unsubscribe"), {
          method: "POST",
          credentials: "include",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            endpoint: subscription.endpoint,
          }),
        });
        await subscription.unsubscribe();
      }

      const nextStatus = await fetchPushStatus();
      setStatus(nextStatus);
      setMessage("Push notifications were disabled for this device.");
    } catch (unsubscribeError) {
      setError(
        unsubscribeError instanceof Error
          ? unsubscribeError.message
          : "Failed to disable push notifications",
      );
    } finally {
      setBusyAction(null);
    }
  }

  async function sendTest() {
    setBusyAction("test");
    setMessage(null);
    setError(null);

    try {
      const response = await fetch(apiUrl("/api/notifications/push/test"), {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      });

      if (!response.ok) {
        throw new Error("Failed to send a test push notification.");
      }

      const result = (await response.json()) as { delivered?: number };
      setMessage(
        result.delivered && result.delivered > 0
          ? "Test notification sent."
          : "No push subscription was available for this account.",
      );
    } catch (testError) {
      setError(testError instanceof Error ? testError.message : "Failed to send test push");
    } finally {
      setBusyAction(null);
    }
  }

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-border bg-card p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight text-foreground">
              Mobile notifications
            </h1>
            <p className="text-sm text-muted-foreground">
              Enable web push so new WhatsApp inbox messages can appear as normal mobile
              notifications on supported devices.
            </p>
          </div>
          <div className="rounded-full border border-border bg-secondary/50 px-3 py-1 text-xs font-medium text-muted-foreground">
            {status?.subscribed ? "Subscribed" : "Not subscribed"}
          </div>
        </div>

        <div className="mt-5 flex flex-wrap gap-3">
          <Button
            onClick={subscribe}
            disabled={busyAction !== null || !status?.configured}
          >
            {busyAction === "subscribe" ? "Enabling..." : "Enable notifications"}
          </Button>
          <Button
            variant="outline"
            onClick={unsubscribe}
            disabled={busyAction !== null}
          >
            {busyAction === "unsubscribe" ? "Disabling..." : "Disable on this device"}
          </Button>
          <Button
            variant="outline"
            onClick={sendTest}
            disabled={busyAction !== null || !status?.subscribed}
          >
            {busyAction === "test" ? "Sending..." : "Send test notification"}
          </Button>
        </div>

        {message ? <p className="mt-4 text-sm text-status-success">{message}</p> : null}
        {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
      </section>

      <section className="rounded-xl border border-border bg-card p-5">
        <h2 className="text-lg font-semibold text-foreground">What to expect</h2>
        <div className="mt-3 space-y-2 text-sm text-muted-foreground">
          <p>Android: enable notifications and you are done.</p>
          <p>iPhone/iPad: install the app first, then enable notifications.</p>
        </div>
      </section>
    </div>
  );
}
