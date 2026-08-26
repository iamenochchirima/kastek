"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { buttonClassName } from "@/components/ui/button";

export default function LeadDeleteButton({ leadId }: { leadId: string }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setDeleting(true);
    const res = await fetch(`/api/leads/${leadId}`, { method: "DELETE" });
    if (res.ok) {
      router.push("/leads");
      router.refresh();
    } else {
      setDeleting(false);
      setConfirming(false);
      setError("Failed to delete lead.");
    }
  }

  if (confirming) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Delete this lead?</span>
        <button
          onClick={handleDelete}
          disabled={deleting}
          className={buttonClassName({ variant: "destructive", size: "sm" })}
        >
          {deleting ? "Deleting..." : "Confirm"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          disabled={deleting}
          className={buttonClassName({ variant: "ghost", size: "sm" })}
        >
          Cancel
        </button>
      </div>
    );
  }

  return <div className="flex flex-col items-end gap-2">{error ? <span role="alert" className="text-xs text-status-danger">{error}</span> : null}<button onClick={() => { setError(null); setConfirming(true); }} className={buttonClassName({ variant: "destructive", size: "sm" })}>Delete</button></div>;
}
