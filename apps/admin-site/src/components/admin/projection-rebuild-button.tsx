"use client";

import { useState } from "react";
import { buttonClassName } from "@/components/ui/button";

export function ProjectionRebuildButton() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function rebuild() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/operations/projections/rebuild", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}) });
      const data = await response.json() as { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to rebuild projections");
      setMessage("Operator projections rebuilt.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to rebuild projections");
    } finally {
      setBusy(false);
    }
  }
  return <div className="flex items-center gap-3"><button type="button" disabled={busy} onClick={() => void rebuild()} className={buttonClassName({ variant: "secondary", size: "sm" })}>{busy ? "Rebuilding…" : "Rebuild projections"}</button>{message ? <span className="text-xs text-muted-foreground">{message}</span> : null}</div>;
}
