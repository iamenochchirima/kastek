"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";

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
    <div className="flex flex-wrap items-center gap-3 rounded-[calc(var(--radius)-1px)] border border-line bg-card p-3 shadow-card">
      <div className="flex flex-wrap gap-1.5">
        {STATUSES.map((s) => (
          <button
            key={s.value}
            onClick={() => updateParams("callStatus", s.value)}
            className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              currentStatus === s.value
                ? "bg-primary text-primary-foreground"
                : "bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <Input
        type="text"
        placeholder="Search businesses..."
        defaultValue={currentSearch}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            updateParams("search", e.currentTarget.value);
          }
        }}
        className="h-[var(--density-control-height)] w-64"
      />
    </div>
  );
}
