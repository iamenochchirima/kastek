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

export function playInboxAlertSound(audioContextRef?: { current: AudioContext | null }) {
  if (!supportsAudioContext()) return;

  const AudioCtor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioCtor) return;

  const audioContext = audioContextRef?.current || new AudioCtor();
  if (audioContextRef) {
    audioContextRef.current = audioContext;
  }

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

export async function ensureInboxAlertAudioUnlocked(audioContextRef?: { current: AudioContext | null }) {
  if (!supportsAudioContext()) return false;

  const AudioCtor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  if (!AudioCtor) return false;

  const audioContext = audioContextRef?.current || new AudioCtor();
  if (audioContextRef) {
    audioContextRef.current = audioContext;
  }

  if (audioContext.state === "running") return true;
  if (audioContext.state === "closed") return false;

  try {
    await audioContext.resume();
  } catch {
    return false;
  }

  const nextState: string = audioContext.state;
  return nextState === "running";
}

export async function playInboxAlertSoundSafely(audioContextRef?: { current: AudioContext | null }) {
  const unlocked = await ensureInboxAlertAudioUnlocked(audioContextRef);
  if (!unlocked) return;
  playInboxAlertSound(audioContextRef);
}
