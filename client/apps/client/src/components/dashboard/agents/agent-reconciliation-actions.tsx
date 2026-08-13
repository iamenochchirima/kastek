"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { reconcileAgentEffect, type AgentEffectReceipt } from "@/lib/agent-platform";

export function AgentReconciliationActions({ effect }: { effect: AgentEffectReceipt }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"succeeded" | "failed" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (outcome: "succeeded" | "failed") => {
    if (busy || !window.confirm(`Mark this provider effect as ${outcome}? This creates an immutable recovery decision.`)) return;
    setBusy(outcome);
    setError(null);
    try {
      let providerReceipt: Record<string, unknown> | undefined;
      let failure: Record<string, unknown> | undefined;
      if (outcome === "succeeded") {
        const text = window.prompt("Provider receipt JSON (optional)", "{}");
        if (text === null) return;
        const parsed = JSON.parse(text || "{}");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Provider receipt must be a JSON object");
        providerReceipt = parsed as Record<string, unknown>;
      } else {
        const message = window.prompt("Failure reason", "Provider outcome could not be confirmed");
        if (message === null) return;
        failure = { code: "MANUAL_RECONCILIATION", message: message.trim() || "Provider outcome failed" };
      }
      await reconcileAgentEffect(effect.id, { outcome, providerReceipt, error: failure });
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to reconcile effect");
    } finally {
      setBusy(null);
    }
  };

  return <div className="flex flex-wrap items-center gap-2"><Button type="button" size="sm" disabled={busy !== null} onClick={() => void resolve("succeeded")}>{busy === "succeeded" ? "Saving…" : "Mark succeeded"}</Button><Button type="button" size="sm" variant="outline" disabled={busy !== null} onClick={() => void resolve("failed")}>{busy === "failed" ? "Saving…" : "Mark failed"}</Button>{error ? <p className="basis-full text-xs text-destructive" role="alert">{error}</p> : null}</div>;
}
