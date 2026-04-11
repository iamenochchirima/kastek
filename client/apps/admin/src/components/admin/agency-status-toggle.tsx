"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export default function AgencyStatusToggle({
  workspaceId,
  currentStatus,
}: {
  workspaceId: string;
  currentStatus: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const isActive = currentStatus === "active";
  const nextStatus = isActive ? "suspended" : "active";

  async function toggle() {
    setLoading(true);
    await fetch(`/api/agencies/${workspaceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    });
    router.refresh();
    setLoading(false);
  }

  return (
    <div className="flex items-center gap-3">
      <span
        className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${
          isActive
            ? "bg-green-500/15 text-green-400"
            : "bg-red-500/15 text-red-400"
        }`}
      >
        {currentStatus}
      </span>
      <button
        onClick={toggle}
        disabled={loading}
        className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors disabled:opacity-50 ${
          isActive
            ? "border-red-500/30 text-red-400 hover:bg-red-500/10"
            : "border-green-500/30 text-green-400 hover:bg-green-500/10"
        }`}
      >
        {loading ? "…" : isActive ? "Suspend" : "Activate"}
      </button>
    </div>
  );
}
