"use client";

import { useRouter, useSearchParams } from "next/navigation";

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
    <div className="flex flex-wrap items-center gap-3">
      <form onSubmit={handleSearch} className="flex-1 min-w-[200px]">
        <input
          name="search"
          type="text"
          placeholder="Search leads..."
          defaultValue={searchParams.get("search") || ""}
          className="w-full px-3 py-2 bg-surface-raised border border-border rounded-lg text-sm text-text placeholder:text-text-faint focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
      </form>

      <select
        value={searchParams.get("status") || ""}
        onChange={(e) => updateFilter("status", e.target.value)}
        className="px-3 py-2 bg-surface-raised border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
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
        className="px-3 py-2 bg-surface-raised border border-border rounded-lg text-sm text-text focus:outline-none focus:ring-2 focus:ring-primary/50"
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
          className="text-sm text-text-muted hover:text-text"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}
