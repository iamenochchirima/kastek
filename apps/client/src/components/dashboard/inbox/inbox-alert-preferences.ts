"use client";

export const DESKTOP_ALERTS_KEY = "kasiai:inbox-desktop-alerts";
export const SOUND_ALERTS_KEY = "kasiai:inbox-sound-alerts";
export const ALERT_SETTINGS_EVENT = "kasiai:inbox-alert-settings";

export type InboxAlertPreferences = {
  desktopAlertsEnabled: boolean;
  soundAlertsEnabled: boolean;
};

export function supportsDesktopNotifications() {
  return typeof window !== "undefined" && "Notification" in window;
}

export function supportsAudioContext() {
  return typeof window !== "undefined" && ("AudioContext" in window || "webkitAudioContext" in window);
}

export function getStoredBoolean(key: string, fallback: boolean) {
  if (typeof window === "undefined") return fallback;
  const value = window.localStorage.getItem(key);
  if (value === null) return fallback;
  return value === "true";
}

export function readInboxAlertPreferences(): InboxAlertPreferences {
  return {
    desktopAlertsEnabled: supportsDesktopNotifications()
      ? getStoredBoolean(DESKTOP_ALERTS_KEY, window.Notification.permission === "granted")
      : false,
    soundAlertsEnabled: getStoredBoolean(SOUND_ALERTS_KEY, true),
  };
}

export function writeInboxAlertPreferences(next: Partial<InboxAlertPreferences>) {
  if (typeof window === "undefined") return;

  const current = readInboxAlertPreferences();
  const merged = { ...current, ...next };

  window.localStorage.setItem(DESKTOP_ALERTS_KEY, String(merged.desktopAlertsEnabled));
  window.localStorage.setItem(SOUND_ALERTS_KEY, String(merged.soundAlertsEnabled));
  window.dispatchEvent(new CustomEvent(ALERT_SETTINGS_EVENT, { detail: merged }));
}
