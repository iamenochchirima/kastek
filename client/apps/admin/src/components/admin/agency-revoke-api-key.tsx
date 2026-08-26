"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonClassName } from "@/components/ui/button";

export default function AgencyRevokeApiKey({
  workspaceId,
  keyId,
  keyLabel,
}: {
  workspaceId: string;
  keyId: string;
  keyLabel: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleRevoke() {
    setLoading(true);
    await fetch(`/api/agencies/${workspaceId}/api-keys/${keyId}`, { method: "DELETE" });
    router.refresh();
    setLoading(false);
    setConfirming(false);
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Revoke &ldquo;{keyLabel}&rdquo;?</span>
        <button
          onClick={handleRevoke}
          disabled={loading}
          className={buttonClassName({ variant: "destructive", size: "sm" })}
        >
          {loading ? "…" : "Revoke"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className={buttonClassName({ variant: "ghost", size: "sm" })}
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-status-danger-soft hover:text-status-danger"
    >
      Revoke
    </button>
  );
}
