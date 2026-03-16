"use client";

import type { MutableRefObject } from "react";
import { useEffect, useRef, useState } from "react";
import {
  ALERT_SETTINGS_EVENT,
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
      if (!event.key || event.key.startsWith("kasiai:inbox-")) {
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
      playAlertSound(audioContextRef);
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
      playAlertSound(audioContextRef);
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
          <button
            type="button"
            onClick={enableDesktopAlerts}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              preferences.desktopAlertsEnabled
                ? "border-green-500/30 bg-green-500/10 text-green-300"
                : "border-border bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground"
            }`}
          >
            {desktopButtonLabel}
          </button>
        ) : (
          <span className="rounded-full border border-border bg-secondary/50 px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Desktop Alerts Unsupported
          </span>
        )}

        {supportsAudioContext() ? (
          <button
            type="button"
            onClick={toggleSoundAlerts}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              preferences.soundAlertsEnabled
                ? "border-accent/30 bg-accent/10 text-accent"
                : "border-border bg-secondary/50 text-muted-foreground hover:bg-secondary hover:text-foreground"
            }`}
          >
            {preferences.soundAlertsEnabled ? "Sound On" : "Sound Off"}
          </button>
        ) : (
          <span className="rounded-full border border-border bg-secondary/50 px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Sound Unsupported
          </span>
        )}
      </div>
    </div>
  );
}

function playAlertSound(audioContextRef: MutableRefObject<AudioContext | null>) {
  if (!supportsAudioContext()) return;

  const AudioCtor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioCtor) return;

  const audioContext = audioContextRef.current || new AudioCtor();
  audioContextRef.current = audioContext;

  if (audioContext.state === "suspended") {
    void audioContext.resume();
  }

  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
  gainNode.gain.setValueAtTime(0.0001, audioContext.currentTime);
  gainNode.gain.exponentialRampToValueAtTime(0.12, audioContext.currentTime + 0.02);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.35);

  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);
  oscillator.start(audioContext.currentTime);
  oscillator.stop(audioContext.currentTime + 0.35);
}
