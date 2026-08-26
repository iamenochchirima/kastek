"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { DataToolbar } from "@/components/admin/data-toolbar";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

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

  const activeFilterCount = ["search", "status", "source"].filter((key) => searchParams.get(key)).length;

  return (
    <DataToolbar
      search={<form onSubmit={handleSearch}><Input name="search" type="text" placeholder="Search leads..." defaultValue={searchParams.get("search") || ""} /></form>}
      filters={<>
        <Select value={searchParams.get("status") || ""} onChange={(e) => updateFilter("status", e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {STATUSES.map((s) => <option key={s} value={s} className="capitalize">{s}</option>)}
        </Select>
        <Select value={searchParams.get("source") || ""} onChange={(e) => updateFilter("source", e.target.value)} aria-label="Filter by source">
          <option value="">All sources</option>
          {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </Select>
      </>}
      activeFilterCount={activeFilterCount}
      onClearFilters={() => router.push("/leads")}
    />
  );
}
