"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  ALERT_SETTINGS_EVENT,
  playInboxAlertSoundSafely,
  readInboxAlertPreferences,
  supportsAudioContext,
  supportsDesktopNotifications,
  writeInboxAlertPreferences,
} from "./inbox-alert-preferences";

type InboxAlertControlsProps = {
  title?: string;
  showStatus?: boolean;
  compact?: boolean;
};

export default function InboxAlertControls({
  title = "Workspace",
  showStatus = false,
  compact = true,
}: InboxAlertControlsProps) {
  const audioContextRef = useRef<AudioContext | null>(null);
  const [preferences, setPreferences] = useState(readInboxAlertPreferences);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission>(() =>
    supportsDesktopNotifications() ? window.Notification.permission : "default"
  );

  useEffect(() => {
    if (typeof window === "undefined") return;

    const sync = () => {
      setPreferences(readInboxAlertPreferences());
      if (supportsDesktopNotifications()) {
        setNotificationPermission(window.Notification.permission);
      }
    };

    const handleStorage = (event: StorageEvent) => {
      if (!event.key || event.key.startsWith("growth:inbox-")) {
        sync();
      }
    };

    window.addEventListener("storage", handleStorage);
    window.addEventListener(ALERT_SETTINGS_EVENT, sync as EventListener);

    return () => {
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener(ALERT_SETTINGS_EVENT, sync as EventListener);
    };
  }, []);

  async function enableDesktopAlerts() {
    if (!supportsDesktopNotifications()) return;

    const permission = await window.Notification.requestPermission();
    setNotificationPermission(permission);
    writeInboxAlertPreferences({ desktopAlertsEnabled: permission === "granted" });

    if (permission === "granted" && preferences.soundAlertsEnabled) {
      void playInboxAlertSoundSafely(audioContextRef);
      new window.Notification(title, {
        body: "Desktop alerts are now enabled for new inbox messages.",
        tag: "desktop-alerts-enabled",
      });
    }
  }

  function toggleSoundAlerts() {
    const next = !preferences.soundAlertsEnabled;
    writeInboxAlertPreferences({ soundAlertsEnabled: next });
    if (next) {
      void playInboxAlertSoundSafely(audioContextRef);
    }
  }

  const desktopButtonLabel = preferences.desktopAlertsEnabled
    ? "Desktop Alerts On"
    : notificationPermission === "denied"
      ? "Desktop Alerts Blocked"
      : "Desktop Alerts Off";

  return (
    <div className={compact ? "flex flex-wrap items-center gap-2" : "space-y-3"}>
      {showStatus ? (
        <p className="text-sm text-muted-foreground">
          Browser permission:{" "}
          <span className="font-medium text-foreground">
            {supportsDesktopNotifications() ? notificationPermission : "not supported"}
          </span>
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {supportsDesktopNotifications() ? (
          <Button
            type="button"
            onClick={enableDesktopAlerts}
            size="sm"
            variant="outline"
            className={
              preferences.desktopAlertsEnabled
                ? "border-status-success/30 bg-status-success-soft text-status-success hover:bg-status-success-soft"
                : "text-muted-foreground"
            }
          >
            {desktopButtonLabel}
          </Button>
        ) : (
          <span className="rounded-full border border-border bg-secondary/50 px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Desktop Alerts Unsupported
          </span>
        )}

        {supportsAudioContext() ? (
          <Button
            type="button"
            onClick={toggleSoundAlerts}
            size="sm"
            variant="outline"
            className={
              preferences.soundAlertsEnabled
                ? "border-status-success/30 bg-status-success-soft text-status-success hover:bg-status-success-soft"
                : "text-muted-foreground"
            }
          >
            {preferences.soundAlertsEnabled ? "Sound On" : "Sound Off"}
          </Button>
        ) : (
          <span className="rounded-full border border-border bg-secondary/50 px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Sound Unsupported
          </span>
        )}
      </div>
    </div>
  );
}
