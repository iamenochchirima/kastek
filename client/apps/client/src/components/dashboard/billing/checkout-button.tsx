"use client";

import { apiUrl } from "@/lib/server-api";
import { useState } from "react";

export function CheckoutButton({ planKey, disabled = false }: { planKey: string; disabled?: boolean }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function startCheckout() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(apiUrl("/api/billing/checkout"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planKey }),
      });
      const body = await response.json();
      if (!response.ok || !body.authorizationUrl) {
        throw new Error(body.error || "Checkout could not be started");
      }
      window.location.assign(body.authorizationUrl);
    } catch (checkoutError) {
      setError(checkoutError instanceof Error ? checkoutError.message : "Checkout could not be started");
      setLoading(false);
    }
  }

  return (
    <div className="mt-4">
      <button
        type="button"
        disabled={disabled || loading}
        onClick={startCheckout}
        className="inline-flex h-10 w-full items-center justify-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {loading ? "Opening checkout..." : disabled ? "Checkout unavailable" : "Choose plan"}
      </button>
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
