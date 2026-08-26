"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";

const STATUSES = ["new", "contacted", "interested", "quoted", "won", "lost"];
const SOURCES = [
  { value: "website", label: "Website" },
  { value: "facebook", label: "Facebook" },
  { value: "linkedin", label: "LinkedIn" },
  { value: "cold_email", label: "Cold Email" },
  { value: "referral", label: "Referral" },
  { value: "whatsapp", label: "WhatsApp" },
  { value: "walk_in", label: "Walk-in" },
];

export default function LeadFilters() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const updateFilter = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    router.push(`/leads?${params.toString()}`);
  };

  const handleSearch = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const formData = new FormData(e.currentTarget);
    updateFilter("search", formData.get("search") as string);
  };

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[calc(var(--radius)-1px)] border border-line bg-card p-3 shadow-card">
      <form onSubmit={handleSearch} className="min-w-[200px] flex-1">
        <Input
          name="search"
          type="text"
          placeholder="Search leads..."
          defaultValue={searchParams.get("search") || ""}
        />
      </form>

      <select
        value={searchParams.get("status") || ""}
        onChange={(e) => updateFilter("status", e.target.value)}
        className="h-[var(--density-control-height)] min-w-36 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <option value="">All Statuses</option>
        {STATUSES.map((s) => (
          <option key={s} value={s} className="capitalize">
            {s}
          </option>
        ))}
      </select>

      <select
        value={searchParams.get("source") || ""}
        onChange={(e) => updateFilter("source", e.target.value)}
        className="h-[var(--density-control-height)] min-w-36 rounded-md border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <option value="">All Sources</option>
        {SOURCES.map((s) => (
          <option key={s.value} value={s.value}>
            {s.label}
          </option>
        ))}
      </select>

      {(searchParams.get("status") || searchParams.get("source") || searchParams.get("search")) && (
        <button
          onClick={() => router.push("/leads")}
          className="rounded-md px-2 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
