"use client";

import { useEffect, useRef } from "react";

const PWA_UPDATE_EVENT = "kasitek:pwa-update";

function dispatchPwaUpdate(waiting: boolean) {
  window.dispatchEvent(
    new CustomEvent(PWA_UPDATE_EVENT, {
      detail: { waiting },
    }),
  );
}

export default function PwaRegister() {
  const reloadingRef = useRef(false);

  useEffect(() => {
    if (
      process.env.NODE_ENV !== "production" ||
      typeof window === "undefined" ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }

    const onControllerChange = () => {
      if (reloadingRef.current) return;
      reloadingRef.current = true;
      window.location.reload();
    };

    const onApplyUpdate = () => {
      void navigator.serviceWorker.getRegistration().then((registration) => {
        if (registration?.waiting) {
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
        }
      });
    };

    navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
    window.addEventListener("kasitek:apply-pwa-update", onApplyUpdate as EventListener);

    const register = async () => {
      try {
        const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/" });

        const syncWaitingState = () => {
          dispatchPwaUpdate(Boolean(registration.waiting));
        };

        syncWaitingState();

        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) return;

          installing.addEventListener("statechange", () => {
            if (installing.state === "installed") {
              syncWaitingState();
            }
          });
        });

        navigator.serviceWorker.addEventListener("message", () => {
          syncWaitingState();
        });
      } catch (error) {
        if (process.env.NODE_ENV !== "production") {
          console.error("Failed to register service worker", error);
        }
      }
    };

    void register();

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
      window.removeEventListener("kasitek:apply-pwa-update", onApplyUpdate as EventListener);
    };
  }, []);

  return null;
}
