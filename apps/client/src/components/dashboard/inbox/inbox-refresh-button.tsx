"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function InboxRefreshButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function refreshInbox() {
    setLoading(true);
    router.refresh();
    setTimeout(() => setLoading(false), 500);
  }

  return (
    <button
      type="button"
      onClick={refreshInbox}
      disabled={loading}
      className="rounded-lg border border-border px-4 py-2 text-sm text-text no-underline hover:border-border-light disabled:opacity-60"
    >
      {loading ? "Refreshing..." : "Refresh"}
    </button>
  );
}
