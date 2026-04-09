"use client";

import { useRouter, useSearchParams } from "next/navigation";

const STATUSES = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "called", label: "Called" },
  { value: "interested", label: "Interested" },
  { value: "not_interested", label: "Not Interested" },
  { value: "no_answer", label: "No Answer" },
  { value: "callback", label: "Callback" },
  { value: "dead", label: "Dead" },
];

export default function WebServicesFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentStatus = searchParams.get("callStatus") || "";
  const currentSearch = searchParams.get("search") || "";

  function updateParams(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    router.push(`?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-3 flex-wrap">
      <div className="flex gap-1.5">
        {STATUSES.map((s) => (
          <button
            key={s.value}
            onClick={() => updateParams("callStatus", s.value)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              currentStatus === s.value
                ? "bg-primary text-white"
                : "bg-surface-overlay text-text-muted hover:text-text"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <input
        type="text"
        placeholder="Search businesses..."
        defaultValue={currentSearch}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            updateParams("search", e.currentTarget.value);
          }
        }}
        className="px-3 py-1.5 bg-surface border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50 w-64"
      />
    </div>
  );
}
