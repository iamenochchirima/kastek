"use client";

import { apiUrl } from "@/lib/server-api";

export type PushStatusResponse = {
  configured: boolean;
  publicKey: string | null;
  subscribed: boolean;
  subscriptionCount: number;
};

export type LocalPushSupport = {
  notifications: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  secureContext: boolean;
  standalone: boolean;
};

export function getLocalPushSupport(): LocalPushSupport {
  if (typeof window === "undefined") {
    return {
      notifications: false,
      serviceWorker: false,
      pushManager: false,
      secureContext: false,
      standalone: false,
    };
  }

  const mediaMatch =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(display-mode: standalone)").matches;
  const navigatorStandalone =
    "standalone" in window.navigator &&
    Boolean((window.navigator as Navigator & { standalone?: boolean }).standalone);

  return {
    notifications: "Notification" in window,
    serviceWorker: "serviceWorker" in navigator,
    pushManager: "PushManager" in window,
    secureContext: window.isSecureContext,
    standalone: mediaMatch || navigatorStandalone,
  };
}

export function urlBase64ToUint8Array(base64String: string) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = `${base64String}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);

  for (let index = 0; index < rawData.length; index += 1) {
    output[index] = rawData.charCodeAt(index);
  }

  return output;
}

export async function fetchPushStatus() {
  const response = await fetch(apiUrl("/api/notifications/push"), {
    credentials: "include",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Failed to load push notification status");
  }
  return (await response.json()) as PushStatusResponse;
}
