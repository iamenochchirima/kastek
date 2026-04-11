"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AgencyRemoveStaff({
  workspaceId,
  userId,
  userEmail,
}: {
  workspaceId: string;
  userId: string;
  userEmail: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [loading, setLoading] = useState(false);

  async function handleRemove() {
    setLoading(true);
    await fetch(`/api/agencies/${workspaceId}/staff/${userId}`, { method: "DELETE" });
    router.refresh();
    setLoading(false);
    setConfirming(false);
  }

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs text-text-muted">Remove {userEmail}?</span>
        <button
          onClick={handleRemove}
          disabled={loading}
          className="px-2.5 py-1 rounded text-xs font-medium bg-danger/10 text-danger border border-danger/20 hover:bg-danger/20 transition-colors disabled:opacity-50"
        >
          {loading ? "…" : "Confirm"}
        </button>
        <button
          onClick={() => setConfirming(false)}
          className="px-2.5 py-1 rounded text-xs font-medium text-text-muted hover:text-text transition-colors"
        >
          Cancel
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={() => setConfirming(true)}
      className="px-2.5 py-1 rounded text-xs font-medium text-text-faint hover:text-danger transition-colors"
    >
      Remove
    </button>
  );
}
