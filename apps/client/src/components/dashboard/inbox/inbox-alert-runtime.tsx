"use client";

import type { WhatsappRealtimeEvent } from "@/lib/whatsapp/types";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";
import { getWhatsappMessagePreview } from "@/lib/whatsapp/message-content";
import {
  ALERT_SETTINGS_EVENT,
  readInboxAlertPreferences,
  supportsAudioContext,
  supportsDesktopNotifications,
} from "./inbox-alert-preferences";

function getActiveConversationId(pathname: string) {
  const match = pathname.match(/^\/dashboard\/inbox\/whatsapp\/([^/]+)$/);
  return match?.[1] || null;
}

export default function InboxAlertRuntime() {
  const pathname = usePathname();
  const audioContextRef = useRef<AudioContext | null>(null);
  const [preferences, setPreferences] = useState(readInboxAlertPreferences);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const sync = () => {
      setPreferences(readInboxAlertPreferences());
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

  useEffect(() => {
    const source = new EventSource("/api/realtime/whatsapp");

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as WhatsappRealtimeEvent;
        if (payload.type !== "message.created" || payload.message.sender !== "customer") {
          return;
        }

        const activeConversationId = getActiveConversationId(pathname);
        const sameConversationVisible =
          activeConversationId === payload.conversationId &&
          document.visibilityState === "visible" &&
          document.hasFocus();

        if (sameConversationVisible) {
          return;
        }

        const contactName = payload.conversation?.customerName || "New contact";
        const preview = getWhatsappMessagePreview(payload.message.content, 140);

        if (preferences.soundAlertsEnabled) {
          playAlertSound(audioContextRef);
        }

        if (
          preferences.desktopAlertsEnabled &&
          supportsDesktopNotifications() &&
          window.Notification.permission === "granted"
        ) {
          const notification = new window.Notification(contactName, {
            body: preview || "Sent you a new WhatsApp message.",
            tag: `conversation:${payload.conversationId}`,
          });

          notification.onclick = () => {
            window.focus();
            window.location.href = `/dashboard/inbox/whatsapp/${payload.conversationId}`;
            notification.close();
          };
        }
      } catch {
        // Ignore malformed realtime payloads for alerting.
      }
    };

    return () => {
      source.close();
    };
  }, [pathname, preferences.desktopAlertsEnabled, preferences.soundAlertsEnabled]);

  return null;
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
