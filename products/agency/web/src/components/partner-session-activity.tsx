"use client";

import { useEffect } from "react";
import { tenantFetch } from "@/lib/api";

const ACTIVITY_THROTTLE_MS = 5 * 60 * 1000;

export default function PartnerSessionActivity() {
  useEffect(() => {
    let active = true;
    let lastTouch = 0;

    const onActivity = () => {
      if (!active || document.visibilityState !== "visible") return;
      const now = Date.now();
      if (now - lastTouch < ACTIVITY_THROTTLE_MS) return;
      lastTouch = now;
      void tenantFetch("/api/partner/auth/activity", { method: "POST" }).catch(
        () => {},
      );
    };

    const attachListeners = () => {
      if (!active) return;
      window.addEventListener("pointerdown", onActivity, { passive: true });
      window.addEventListener("keydown", onActivity);
      window.addEventListener("wheel", onActivity, { passive: true });
    };

    void tenantFetch("/api/partner/auth/me")
      .then(attachListeners)
      .catch(() => {});

    return () => {
      active = false;
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("wheel", onActivity);
    };
  }, []);

  return null;
}
