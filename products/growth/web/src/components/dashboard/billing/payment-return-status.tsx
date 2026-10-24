import { apiUrl } from "@/lib/server-api";
import { useRevalidator } from "react-router";
import { useEffect, useState } from "react";

type VerificationState = "verifying" | "completed" | "pending" | "failed" | "error";

export function PaymentReturnStatus({ reference }: { reference: string }) {
  const revalidator = useRevalidator();
  const [state, setState] = useState<VerificationState>("verifying");
  const [message, setMessage] = useState("Verifying the payment with Paystack...");

  useEffect(() => {
    const controller = new AbortController();

    async function verify() {
      try {
        const response = await fetch(
          apiUrl(`/api/billing/checkout/${encodeURIComponent(reference)}/verify`),
          { method: "POST", credentials: "include", signal: controller.signal },
        );
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "Payment verification failed");

        if (body.status === "completed") {
          setState("completed");
          setMessage("Payment verified. Product access has been updated.");
          revalidator.revalidate();
          return;
        }
        if (body.status === "failed") {
          setState("failed");
          setMessage("This checkout failed. No product access was changed.");
          return;
        }
        setState("pending");
        setMessage("Paystack has not confirmed this payment yet. Reconciliation will check it again automatically.");
      } catch (error) {
        if (controller.signal.aborted) return;
        setState("error");
        setMessage(error instanceof Error ? error.message : "Payment verification failed");
      }
    }

    void verify();
    return () => controller.abort();
  }, [reference, revalidator]);

  const tone = state === "completed"
    ? "border-primary/30 bg-primary/10"
    : state === "failed" || state === "error"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : "border-border bg-card";

  return (
    <div className={`rounded-xl border p-4 text-sm ${tone}`} role="status" aria-live="polite">
      <p className="font-medium">
        {state === "verifying" ? "Verifying payment" : state === "completed" ? "Payment complete" : "Payment status"}
      </p>
      <p className="mt-1">{message}</p>
      <p className="mt-2 font-mono text-xs opacity-70">Reference: {reference}</p>
    </div>
  );
}
