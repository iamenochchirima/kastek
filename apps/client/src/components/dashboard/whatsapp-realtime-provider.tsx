"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import { apiUrl } from "@/lib/server-api";
import type { WhatsappRealtimeEvent } from "@/lib/whatsapp/types";
import {
  ensureInboxAlertAudioUnlocked,
  playInboxAlertSoundSafely,
  readInboxAlertPreferences,
  supportsDesktopNotifications,
} from "@/components/dashboard/inbox/inbox-alert-preferences";

type InboxUnreadListener = () => void;
type EventListener = (event: WhatsappRealtimeEvent) => void;

type WhatsappRealtimeStore = {
  getInboxUnreadCount: () => number;
  subscribeInboxUnreadCount: (listener: InboxUnreadListener) => () => void;
  subscribeEvents: (listener: EventListener) => () => void;
};

const WhatsappRealtimeContext = createContext<WhatsappRealtimeStore | null>(null);

function useWhatsappRealtimeStore() {
  const store = useContext(WhatsappRealtimeContext);
  if (!store) {
    throw new Error("Whatsapp realtime context is not available");
  }
  return store;
}

export function WhatsappRealtimeProvider({
  initialInboxUnreadCount,
  children,
}: {
  initialInboxUnreadCount: number;
  children: React.ReactNode;
}) {
  const inboxUnreadCountRef = useRef(initialInboxUnreadCount);
  const inboxUnreadListenersRef = useRef(new Set<InboxUnreadListener>());
  const eventListenersRef = useRef(new Set<EventListener>());
  const reconcileTimerRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const notifiedMessageIdsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const normalized = Math.max(0, initialInboxUnreadCount);
    if (inboxUnreadCountRef.current === normalized) {
      return;
    }
    inboxUnreadCountRef.current = normalized;
    for (const listener of inboxUnreadListenersRef.current) {
      listener();
    }
  }, [initialInboxUnreadCount]);

  const store = useMemo<WhatsappRealtimeStore>(
    () => ({
      getInboxUnreadCount: () => inboxUnreadCountRef.current,
      subscribeInboxUnreadCount: (listener) => {
        inboxUnreadListenersRef.current.add(listener);
        return () => {
          inboxUnreadListenersRef.current.delete(listener);
        };
      },
      subscribeEvents: (listener) => {
        eventListenersRef.current.add(listener);
        return () => {
          eventListenersRef.current.delete(listener);
        };
      },
    }),
    [],
  );

  useEffect(() => {
    let cancelled = false;

    const publishInboxUnreadCount = (nextCount: number) => {
      const normalized = Math.max(0, nextCount);
      if (inboxUnreadCountRef.current === normalized) {
        return;
      }
      inboxUnreadCountRef.current = normalized;
      for (const listener of inboxUnreadListenersRef.current) {
        listener();
      }
    };

    const syncUnreadCount = async () => {
      try {
        const response = await fetch(apiUrl("/api/whatsapp/inbox/unread-count"), {
          cache: "no-store",
          credentials: "include",
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { unreadCount?: number };
        if (cancelled || typeof payload.unreadCount !== "number") return;
        publishInboxUnreadCount(payload.unreadCount);
      } catch {
        // Ignore transient reconcile failures.
      }
    };

    const scheduleUnreadSync = () => {
      if (reconcileTimerRef.current !== null) {
        window.clearTimeout(reconcileTimerRef.current);
      }
      reconcileTimerRef.current = window.setTimeout(() => {
        void syncUnreadCount();
      }, 250);
    };

    const unlockAudioOnInteraction = () => {
      void ensureInboxAlertAudioUnlocked(audioContextRef);
    };

    const source = new EventSource(apiUrl("/api/realtime/whatsapp"), {
      withCredentials: true,
    });

    window.addEventListener("pointerdown", unlockAudioOnInteraction, { once: true });
    window.addEventListener("keydown", unlockAudioOnInteraction, { once: true });

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as WhatsappRealtimeEvent;

        for (const listener of eventListenersRef.current) {
          listener(payload);
        }

        if (payload.type === "message.created" && payload.message.sender === "customer") {
          const messageId = payload.message.id;
          if (!notifiedMessageIdsRef.current.has(messageId)) {
            notifiedMessageIdsRef.current.add(messageId);
            if (notifiedMessageIdsRef.current.size > 200) {
              const oldest = notifiedMessageIdsRef.current.values().next().value;
              if (oldest) {
                notifiedMessageIdsRef.current.delete(oldest);
              }
            }

            const preferences = readInboxAlertPreferences();
            if (preferences.soundAlertsEnabled) {
              void playInboxAlertSoundSafely(audioContextRef);
            }

            if (
              preferences.desktopAlertsEnabled &&
              supportsDesktopNotifications() &&
              window.Notification.permission === "granted"
            ) {
              const customerName =
                payload.conversation?.customerName?.trim() ||
                payload.conversation?.phone ||
                "New WhatsApp message";
              const body =
                payload.message.content.trim() || "You have a new inbound WhatsApp message.";
              new window.Notification(customerName, {
                body,
                tag: `kasitek-whatsapp-${payload.conversationId}`,
              });
            }
          }

          publishInboxUnreadCount(inboxUnreadCountRef.current + 1);
          scheduleUnreadSync();
          return;
        }

        if (payload.type === "conversation.updated") {
          scheduleUnreadSync();
        }
      } catch {
        // Ignore malformed realtime payloads.
      }
    };

    return () => {
      cancelled = true;
      source.close();
      window.removeEventListener("pointerdown", unlockAudioOnInteraction);
      window.removeEventListener("keydown", unlockAudioOnInteraction);
      if (reconcileTimerRef.current !== null) {
        window.clearTimeout(reconcileTimerRef.current);
        reconcileTimerRef.current = null;
      }
    };
  }, []);

  return (
    <WhatsappRealtimeContext.Provider value={store}>{children}</WhatsappRealtimeContext.Provider>
  );
}

export function useWhatsappInboxUnreadCount() {
  const store = useWhatsappRealtimeStore();
  return useSyncExternalStore(
    store.subscribeInboxUnreadCount,
    store.getInboxUnreadCount,
    store.getInboxUnreadCount,
  );
}

export function useWhatsappRealtimeSubscription(handler: EventListener) {
  const store = useWhatsappRealtimeStore();
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    return store.subscribeEvents((event) => {
      handlerRef.current(event);
    });
  }, [store]);
}
