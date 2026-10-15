"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { DataToolbar } from "@/components/admin/data-toolbar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const STATUSES = [
  { value: "", label: "All" },
  { value: "pending", label: "Pending" },
  { value: "sent", label: "Sent" },
  { value: "replied", label: "Replied" },
  { value: "interested", label: "Interested" },
  { value: "not_interested", label: "Not Interested" },
  { value: "bounced", label: "Bounced" },
];

export default function OutreachLeadFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentStatus = searchParams.get("emailStatus") || "";
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
    <DataToolbar
      search={<Input type="text" placeholder="Search businesses..." defaultValue={currentSearch} aria-label="Search businesses" onKeyDown={(e) => { if (e.key === "Enter") updateParams("search", e.currentTarget.value); }} />}
      filters={<div className="flex flex-wrap gap-1.5">
        {STATUSES.map((s) => (
          <Button
            key={s.value}
            type="button"
            size="sm"
            variant={currentStatus === s.value ? "primary" : "secondary"}
            onClick={() => updateParams("emailStatus", s.value)}
          >
            {s.label}
          </Button>
        ))}
      </div>}
      activeFilterCount={[currentStatus, currentSearch].filter(Boolean).length}
      onClearFilters={() => router.push("?")}
    />
  );
}
