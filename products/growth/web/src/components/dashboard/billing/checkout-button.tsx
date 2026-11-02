import { apiUrl } from "@/lib/server-api";
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function CheckoutButton({
  planKey,
  disabled = false,
  label = "Choose plan",
}: {
  planKey: string;
  disabled?: boolean;
  label?: string;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [idempotencyKey] = useState(() => crypto.randomUUID());

  async function startCheckout() {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(apiUrl("/api/billing/checkout"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planKey, idempotencyKey }),
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
      <Button
        type="button"
        disabled={disabled || loading}
        onClick={startCheckout}
        className="w-full"
      >
        {loading ? "Opening checkout..." : label}
      </Button>
      {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
