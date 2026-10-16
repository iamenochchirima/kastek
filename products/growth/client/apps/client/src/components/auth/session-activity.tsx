"use client";

import { useEffect } from "react";
import { apiUrl } from "@/lib/server-api";

// Polling and an open tab do not count as activity. Only browser user input renews idle time.
export function SessionActivity() {
  useEffect(() => {
    let lastSent = 0;
    let pending = false;
    async function record(event: Event) {
      if (!event.isTrusted || document.visibilityState !== "visible" || pending || Date.now() - lastSent < 60_000) return;
      pending = true;
      lastSent = Date.now();
      try {
        const response = await fetch(apiUrl("/api/auth/activity"), {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", "X-Requested-With": "XMLHttpRequest" },
          body: "{}",
        });
        if (response.status === 401) {
          const returnTo = window.location.pathname + window.location.search;
          window.location.assign(`/login?returnTo=${encodeURIComponent(returnTo)}`);
        }
      } catch {
        // A temporary network failure does not claim the server renewed the session.
      } finally { pending = false; }
    }
    document.addEventListener("pointerdown", record, { passive: true });
    document.addEventListener("keydown", record);
    document.addEventListener("wheel", record, { passive: true });
    return () => {
      document.removeEventListener("pointerdown", record);
      document.removeEventListener("keydown", record);
      document.removeEventListener("wheel", record);
    };
  }, []);
  return null;
}
